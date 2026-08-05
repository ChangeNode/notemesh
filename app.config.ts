import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    preset: "node-server",
  },
  // Single-page app: the admin UI is a control panel behind a login on a
  // single-user server. There is no SEO, no first-paint budget and no public
  // traffic to justify rendering it twice, and server rendering cost more than
  // it gave — components had to be correct in two environments, effects that
  // do not run during SSR produced wrong first paints, and an un-hydrated form
  // silently native-submits, which is how a broken sign-in looked like nothing
  // happening at all.
  //
  // With this off there is one build of the UI, and the server is reached only
  // over HTTP: /api/rpc for the admin panel, /api/mcp for clients, /api/auth
  // for Better Auth. src/server/** cannot be imported by the browser because
  // nothing in the client graph references it.
  ssr: false,
  middleware: "src/middleware.ts",
});
