# RankOps Connector (WordPress must-use plugin)

The console works without this plugin, but three things need it:

| Without it | With it |
|---|---|
| SEO meta (canonical, robots) is stripped by core REST — the canonical and noindex fixes cannot write | Those fields are registered for REST and writable |
| Revision counts and `WP_DEBUG_DISPLAY` are invisible → those checks report **unknown** | Both are readable, so the checks return a real verdict |
| Organization schema has nowhere to live | Published sitewide from one option |

## Install

1. Copy `rankops-connector.php` to `wp-content/mu-plugins/` on the site (create the folder if it does not exist).
2. That's it — must-use plugins activate automatically and cannot be deactivated from the admin by accident.
3. In RankOps → Site settings → **Test connection**. "Companion plugin: installed" confirms it.

## Security

Every route requires `manage_options`, so only the administrator account whose Application Password the console holds can call them. Nothing is exposed publicly.

## Creating the Application Password

On the WordPress site: **Users → Profile → Application Passwords**, name it `RankOps Console`, and paste the generated password into Site settings. Revoking it there instantly cuts the console off.
