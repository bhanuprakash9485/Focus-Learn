import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Last line of defense against a blank screen: if any component below this
 * boundary throws during render, we show the message instead of unmounting
 * the whole tree.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[FocusLearn] render error:', error, errorInfo)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="card" style={{ padding: '2rem', maxWidth: 560 }}>
            <h2>Something went wrong</h2>
            <p className="small muted" style={{ marginTop: '0.4rem' }}>
              {this.state.error.message}
            </p>
            <button
              className="btn btn-primary"
              style={{ marginTop: '1rem' }}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}