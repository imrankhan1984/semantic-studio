/*
================================================================================
FILE: frontend/src/main.tsx
================================================================================

SUMMARY
    The frontend entry point. Mounts the root React component (<App/>) into the
    #root element in index.html and loads the global stylesheet.

BASIC IDEA
    Every React app needs a single bootstrap that attaches the component tree
    to a real DOM node. This is that bootstrap — deliberately tiny, so all real
    logic lives in App and its children.

    The one thing it does beyond mounting is wrap the tree in ErrorBoundary. It
    belongs here rather than inside App because a throw in App's own render is
    exactly the case that used to blank the page, and a boundary inside the
    component it is protecting cannot catch that.

INPUTS / INPUT SOURCES
    - The #root <div> defined in index.html.
    - The <App/> component tree and index.css.

EXPECTED OUTPUT
    - The rendered application in the browser, or the crash screen if it throws
      while rendering.
================================================================================
*/

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
// Global styles (CSS variables, themes, and every component's classes).
import "./index.css";

// Find the mount point (the "!" asserts it exists — index.html guarantees it)
// and render the app. StrictMode adds dev-only checks and double-invokes some
// lifecycles to surface side-effect bugs; it has no effect in production.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
