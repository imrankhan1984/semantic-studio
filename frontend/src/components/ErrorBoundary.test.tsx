// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ErrorBoundary.test.tsx
================================================================================

SUMMARY
    Tests for the boundary that stands between a render throw and a blank page:
    that children render untouched when nothing throws, that a throw produces a
    message rather than an empty root, and that the message reaches assistive
    technology and can be recovered from.

BASIC IDEA
    A component that throws on render is all the fixture needed. React logs the
    error itself before the boundary sees it, so console.error is silenced for
    these tests — the assertion that the boundary logs its own diagnosis is made
    on the call it makes, not on the noise around it.

    The point of the boundary is what does NOT happen, so the load-bearing
    assertion is that the container still has content. Deleting
    getDerivedStateFromError makes that one fail with an empty container, which
    is exactly the defect it exists to prevent.

INPUTS / INPUT SOURCES
    - A component that throws on render.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ErrorBoundary from "./ErrorBoundary";

/** The real thing that crashed the app, in the shape React sees it. */
const MESSAGE =
  'Graph.areNeighbors: could not find the "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" node in the graph.';

function Boom(): JSX.Element {
  throw new Error(MESSAGE);
}

let consoleError: ReturnType<typeof vi.spyOn>;

/** React in development re-throws a caught error as an uncaught window error so
 *  devtools can see it; jsdom then prints the whole stack. Swallowed here, or
 *  five passing tests look like five failures in the run output. */
const swallow = (event: Event) => event.preventDefault();

beforeEach(() => {
  // React logs every caught error itself, in addition to the boundary's own
  // log. Silenced so a passing run is not indistinguishable from a failing one
  // in the output.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", swallow);
});

afterEach(() => {
  window.removeEventListener("error", swallow);
  consoleError.mockRestore();
  document.body.innerHTML = "";
});

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>the application</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("the application")).toBeTruthy();
    expect(document.querySelector(".crash-screen")).toBeNull();
  });

  it("shows a message instead of an empty page when a child throws", () => {
    // The whole feature. Without the boundary React unmounts the tree and the
    // container is left empty — which is what a user saw as a blank white page,
    // with the real explanation only in the console.
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(container.textContent).not.toBe("");
    expect(document.querySelector(".crash-screen")).toBeTruthy();
    expect(screen.getByText("Something went wrong.")).toBeTruthy();
  });

  it("names the error rather than hiding it", () => {
    // A boundary that swallows what happened is worse than the blank page: at
    // least the blank page sent people to the console. The message is rendered
    // as text, so an IRI out of a loaded file cannot become markup.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const detail = document.querySelector(".crash-detail")!;
    expect(detail.textContent).toBe(MESSAGE);
    expect(detail.innerHTML).not.toContain("<");
  });

  it("announces itself and offers a way out", () => {
    // role=alert because the interface has just stopped and the user needs to
    // be told without going looking. The reload is a real button, so it is
    // reachable by keyboard like everything else.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    const reload = screen.getByRole("button", { name: /reload/i });
    expect(reload.tagName).toBe("BUTTON");

    // jsdom has no navigation, so the call is what can be asserted. Replacing
    // location.reload is the only way to observe it at all here.
    const reloadSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    });
    fireEvent.click(reload);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("is wired around the application", async () => {
    // A boundary nothing is inside protects nothing, and every test above would
    // still pass with main.tsx not using it. This asserts on source text, like
    // no-raw-html.test.ts and focus-visible.test.ts, because the alternative is
    // importing an entry point whose only job is to mount into a real #root.
    const main = (await import("../main.tsx?raw")).default;

    // First, that the file loaded at all: a `?raw` import that quietly yields
    // "" would make every assertion below pass while proving nothing. That trap
    // cost this project a green suite once already.
    expect(main.length).toBeGreaterThan(100);
    expect(main).toContain("<App />");

    expect(main).toContain("<ErrorBoundary>");
    expect(main).toContain("</ErrorBoundary>");
  });

  it("logs the error and the component stack", () => {
    // The boundary replaces a console-only failure with an on-screen one, and
    // must not take the console half away: the component stack says *where*,
    // and it exists nowhere else.
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    const own = consoleError.mock.calls.find(
      (call: unknown[]) => call[0] === "Unhandled error while rendering:",
    );
    expect(own, "the boundary did not log").toBeTruthy();
    expect((own![1] as Error).message).toBe(MESSAGE);
    expect(String(own![2])).toContain("Boom");
  });
});
