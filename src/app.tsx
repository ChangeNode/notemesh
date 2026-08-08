import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { MetaProvider, Title } from "@solidjs/meta";
import { ErrorBoundary, Suspense } from "solid-js";
import { AppError } from "~/components/AppError";
import "@picocss/pico/css/pico.violet.min.css";
import "./app.css";

export default function App() {
  return (
    <Router
      root={(props) => (
        <MetaProvider>
          <Title>NoteMesh</Title>
          {/* Without this, a component that throws renders SolidStart's bare
              "Uncaught Client Exception" — which is what an operator actually
              saw when a bad chunk shipped, and it says nothing they can act on
              or report. AppError shows the trace instead. */}
          <ErrorBoundary fallback={(err, reset) => <AppError error={err} reset={reset} />}>
            <Suspense>{props.children}</Suspense>
          </ErrorBoundary>
        </MetaProvider>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
