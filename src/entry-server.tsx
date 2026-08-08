// @refresh reload
import { createHandler, StartServer } from "@solidjs/start/server";

export default createHandler(() => (
  <StartServer
    // Dark only. Pico's stylesheet follows prefers-color-scheme unless
    // data-theme pins it, and this is a single-operator admin console, not a
    // site with visitors to accommodate — one palette is one palette to test
    // and to write CSS against. The color-scheme meta tells the browser to
    // match, so form controls, scrollbars and the pre-paint background are
    // dark too rather than flashing white on load.
    document={({ assets, children, scripts }) => (
      <html lang="en" data-theme="dark">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="color-scheme" content="dark" />
          <meta name="robots" content="noindex, nofollow" />
          {/* In the shell for the same reason as the icons below: with ssr
              disabled, @solidjs/meta renders in the browser, so a <Title> in
              the component tree is absent from the HTML the browser first
              receives — leaving the tab showing the URL until JavaScript runs.
              MetaProvider takes over from here on client navigation. */}
          <title>NoteMesh</title>
          {/* Declared in the document rather than through @solidjs/meta: with
              ssr disabled the component tree renders in the browser, so meta
              tags added there are absent from the HTML a browser first
              receives — and the icon request happens before any of that runs.
              SVG first for browsers that support it, .ico for those that do
              not and because /favicon.ico is fetched by convention regardless
              of what is declared. */}
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
          <link rel="icon" href="/favicon.ico" sizes="32x32" />
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          <link rel="manifest" href="/site.webmanifest" />
          <meta name="theme-color" content="#7540bf" />
          {assets}
        </head>
        <body>
          <div id="app">{children}</div>
          {scripts}
        </body>
      </html>
    )}
  />
));
