import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/AuthGate.js";
import { Layout } from "./components/Layout.js";
import { DEFAULT_PATH, NAV } from "./nav.js";

/**
 * App root: HashRouter (the Mini App is served from a static subpath, so hash
 * routing avoids server-side rewrite config) → AuthGate → Layout shell with one
 * route per NAV entry. Unknown paths redirect to the default section.
 */
export function App() {
  return (
    <HashRouter>
      <AuthGate>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to={`/${DEFAULT_PATH}`} replace />} />
            {NAV.map((entry) => {
              const Screen = entry.component;
              return <Route key={entry.path} path={entry.path} element={<Screen />} />;
            })}
            <Route path="*" element={<Navigate to={`/${DEFAULT_PATH}`} replace />} />
          </Route>
        </Routes>
      </AuthGate>
    </HashRouter>
  );
}
