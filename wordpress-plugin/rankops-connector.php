<?php
/**
 * Plugin Name:  RankOps Connector
 * Description:  Exposes the few things the RankOps Console cannot reach through core REST: SEO meta fields, revision counts, the debug-display flag, and sitewide Organization schema.
 * Version:      1.0.0
 * Author:       Web Solution Zone
 * License:      GPL-2.0-or-later
 *
 * Install: copy this file to wp-content/mu-plugins/rankops-connector.php (create the folder if needed).
 * Must-use plugins activate automatically and cannot be deactivated by accident.
 *
 * Every route requires an authenticated user with `manage_options`, i.e. the administrator whose
 * Application Password the console uses. Nothing here is public.
 */

if (!defined('ABSPATH')) { exit; }

const RANKOPS_NS         = 'rankops/v1';
const RANKOPS_ORG_OPTION = 'rankops_organization_schema';

function rankops_admin_only() {
    return current_user_can('manage_options')
        ? true
        : new WP_Error('rest_forbidden', 'Administrator capability required.', ['status' => 401]);
}

/**
 * Register the SEO meta keys for REST so the console can read and write canonicals, robots and titles.
 * Without this, core strips unregistered meta from REST responses and ignores it on write.
 */
add_action('init', function () {
    $post_keys = ['rank_math_canonical_url', 'rank_math_title', 'rank_math_description',
                  '_yoast_wpseo_canonical', '_yoast_wpseo_title', '_yoast_wpseo_metadesc'];
    foreach (get_post_types(['public' => true], 'names') as $type) {
        foreach ($post_keys as $key) {
            register_post_meta($type, $key, [
                'type' => 'string', 'single' => true, 'show_in_rest' => true, 'default' => '',
                'auth_callback' => function () { return current_user_can('edit_posts'); },
            ]);
        }
    }
    // Term robots is an array in Rank Math (e.g. ["noindex","follow"]).
    foreach (get_taxonomies(['public' => true], 'names') as $tax) {
        register_term_meta($tax, 'rank_math_robots', [
            'single' => false, 'type' => 'string',
            'show_in_rest' => ['schema' => ['type' => 'array', 'items' => ['type' => 'string']]],
            'auth_callback' => function () { return current_user_can('manage_categories'); },
        ]);
        register_term_meta($tax, 'rank_math_canonical_url', [
            'single' => true, 'type' => 'string', 'show_in_rest' => true, 'default' => '',
            'auth_callback' => function () { return current_user_can('manage_categories'); },
        ]);
    }
    // Sitewide Organization schema, written through /wp-json/wp/v2/settings.
    register_setting('options', RANKOPS_ORG_OPTION, [
        'type' => 'string', 'default' => '', 'show_in_rest' => true,
    ]);
}, 20);

add_action('rest_api_init', function () {

    /** What the console cannot see through core REST: revision counts and server flags. */
    register_rest_route(RANKOPS_NS, '/summary', [
        'methods'             => 'GET',
        'permission_callback' => 'rankops_admin_only',
        'callback'            => function () {
            global $wpdb;
            $rows = $wpdb->get_results(
                "SELECT post_parent AS id, COUNT(*) AS count
                   FROM {$wpdb->posts}
                  WHERE post_type = 'revision'
               GROUP BY post_parent
               ORDER BY count DESC
                  LIMIT 25", ARRAY_A);
            $worst = array_map(static fn($r) => [
                'id'    => (int) $r['id'],
                'count' => (int) $r['count'],
                'link'  => get_permalink((int) $r['id']) ?: null,
            ], $rows ?: []);

            $seo = null;
            if (defined('RANK_MATH_VERSION') || class_exists('RankMath')) { $seo = 'Rank Math'; }
            elseif (defined('WPSEO_VERSION')) { $seo = 'Yoast SEO'; }

            return [
                'revisions' => [
                    'total' => (int) $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'revision'"),
                    'worst' => $worst,
                ],
                // The single most dangerous production misconfiguration, and not visible over core REST.
                'debug_display'      => (defined('WP_DEBUG_DISPLAY') && WP_DEBUG_DISPLAY) && (defined('WP_DEBUG') && WP_DEBUG),
                'debug'              => defined('WP_DEBUG') && WP_DEBUG,
                'users_can_register' => (bool) get_option('users_can_register'),
                'seo_plugin'         => $seo,
                'wp_version'         => get_bloginfo('version'),
                'revision_limit'     => defined('WP_POST_REVISIONS') ? WP_POST_REVISIONS : null,
                'plugin_version'     => '1.0.0',
            ];
        },
    ]);

    /** Delete old revisions for one post, keeping the newest N. Irreversible by nature — the console labels it so. */
    register_rest_route(RANKOPS_NS, '/revisions/purge', [
        'methods'             => 'POST',
        'permission_callback' => 'rankops_admin_only',
        'args' => [
            'post_id' => ['required' => true, 'type' => 'integer'],
            'keep'    => ['required' => false, 'type' => 'integer', 'default' => 5],
        ],
        'callback' => function (WP_REST_Request $req) {
            $post_id = (int) $req->get_param('post_id');
            $keep    = max(0, (int) $req->get_param('keep'));
            if (!get_post($post_id)) {
                return new WP_Error('rest_post_invalid_id', 'Invalid ID.', ['status' => 404]);
            }
            $revisions = wp_get_post_revisions($post_id, ['orderby' => 'date', 'order' => 'DESC']);
            $removed = 0;
            foreach (array_slice(array_values($revisions), $keep) as $rev) {
                if (wp_delete_post_revision($rev->ID)) { $removed++; }
            }
            return [
                'post_id'   => $post_id,
                'removed'   => $removed,
                'remaining' => count(wp_get_post_revisions($post_id)),
            ];
        },
    ]);
});

/** Print the Organization schema the console published, if any. */
add_action('wp_head', function () {
    $json = trim((string) get_option(RANKOPS_ORG_OPTION, ''));
    if ($json === '' || json_decode($json) === null) { return; }
    echo "\n<script type=\"application/ld+json\">" . wp_json_encode(json_decode($json)) . "</script>\n";
}, 20);
