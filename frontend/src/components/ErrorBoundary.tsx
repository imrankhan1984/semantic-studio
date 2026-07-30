/*
================================================================================
FILE: frontend/src/components/ErrorBoundary.tsx
================================================================================

SUMMARY
    The last line of defence: catches an exception thrown while React renders
    and shows a message with a way out, instead of letting React unmount the
    whole tree and leave an empty page.

BASIC IDEA
    React's contract is deliberate — an error thrown during rendering with no
    boundary above it unmounts the entire tree, on the grounds that a half
    rendered interface is worse than none. That is right for a framework and
    wrong for this application, where the result was a blank white page with the
    real explanation only in the console. It happened for real: selecting an IRI
    that was not a node in the drawn graph made a graphology lookup throw, and
    the application vanished until the page was reloaded.

    This is not a way to keep going. It renders a dead end on purpose, saying
    what happened and offering a reload, because the state that produced the
    throw is still there and pretending otherwise would be the more dishonest
    failure. What it buys is that the user is told, and that the message names
    the error rather than hiding it.

    A class component because there is no hook form of componentDidCatch. It is
    the only class in this codebase and that is why.

INPUTS / INPUT SOURCES
    - Its children, and whatever they throw while rendering.

EXPECTED OUTPUT
    - The children, normally.
    - A message naming the error, plus a reload control, after a render throw.
    - The error and the component stack on the console, always.
================================================================================
*/

import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Kept even though the fallback shows the message: the component stack is
    // the half that says *where*, and it only exists here. Without this, adding
    // the boundary would have made a crash harder to diagnose than the blank
    // page it replaces.
    console.error("Unhandled error while rendering:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash-screen" role="alert">
        <h1>Something went wrong.</h1>
        <p>
          The interface stopped rather than showing you something wrong. Reloading
          starts again from the ontology library; nothing stored on your machine
          has been changed.
        </p>
        {/* The message as text, never as markup. It can contain an IRI out of a
            loaded file, which is untrusted input — see trust boundary 3. */}
        <p className="crash-detail">{error.message || String(error)}</p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload the application
        </button>
      </div>
    );
  }
}
