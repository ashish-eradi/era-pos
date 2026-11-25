import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; workspace: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="canvas"><section className="panel" role="alert">
      <h1>{this.props.workspace} could not display this screen</h1>
      <p>Reload the workspace. Check the receipt history or payment status before repeating a sale.</p>
      <button onClick={() => window.location.reload()}>Reload workspace</button>
    </section></main>;
  }
}
