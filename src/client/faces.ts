/**
 * Structural faces of the cordis services the panel drives.
 *
 * The browser half reaches `sessions`, `workspaces` and `uiWorkspace` through
 * the cordis service registry, never through value imports of their packages
 * (browser-bundle purity). These interfaces are the exact slice the panel uses,
 * declared here so the panel is a plain React component a test can mount with
 * fakes; `index.ts` casts the live services onto them once.
 *
 * @module @yeezone/dsh-client-ui-teambition/client/faces
 */

/** One text block of a submitted prompt. */
export interface PromptTextBlock {
  readonly type: 'text'
  readonly text: string
}

/** One workspace row the workspace service lists. */
export interface WorkspaceItemView {
  /** Stable workspace id. */
  readonly workspaceId: string
  /** User-visible title (empty when unnamed). */
  readonly title?: string
  /** Absolute directory of the workspace. */
  readonly path?: string
}

/** A retained session reference: `ready` settles once the binding is usable. */
export interface RetainedSession {
  /** Resolves when `binding` may be read. */
  readonly ready: Promise<unknown>
  /** The live session binding. */
  readonly binding: {
    readonly session: {
      /** Queue a prompt into the session. */
      prompt(blocks: readonly PromptTextBlock[], mode: 'queue'): Promise<unknown>
    }
  }
  /** Release the retention (the session itself stays alive). */
  release(): void
}

/** The `sessions` service slice: create a session, retain it, prompt it. */
export interface SessionsFace {
  /** Create a Client Session in a workspace. */
  create(options: { workspaceId: string }): Promise<string>
  /** Retain a created session under this plugin's source. */
  retain(sessionId: string, options: { source: 'teambition' }): RetainedSession
}

/** The `workspaces` service slice: the live workspace roster. */
export interface WorkspacesFace {
  /** Live workspace list state. */
  readonly list: {
    /** Current snapshot. */
    getSnapshot(): { readonly items: readonly WorkspaceItemView[] }
    /** Subscribe to roster changes. */
    subscribe(listener: () => void): () => void
  }
}

/** The `uiWorkspace` service slice: navigate the main view to a session. */
export interface UiWorkspaceFace {
  /** Select a session as the main view's conversation. */
  openSession(sessionId: string): void
}
