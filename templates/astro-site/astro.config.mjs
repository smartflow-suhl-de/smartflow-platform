import { defineConfig } from 'astro/config';

/**
 * One site, one port, one origin: the delivery layer gives every website its own
 * internal port, so `base` stays `/` and Astro can emit absolute asset paths.
 *
 * The build runs in a copied directory with `node_modules` symlinked back to the
 * image, so Vite's cache must not land inside that symlink: the copy is the only
 * writable path the sandbox allows.
 */
export default defineConfig({
  output: 'static',
  build: { format: 'directory' },
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  vite: {
    cacheDir: process.env.SF_SITE_CACHE ?? './.vite-cache',
  },
});