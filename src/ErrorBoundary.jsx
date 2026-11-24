import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error("[Route ErrorBoundary]", error, info?.componentStack);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
    if (typeof this.props.onReset === "function") this.props.onReset();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, background: "#0B111A", color: "#F8FAFC", boxSizing: "border-box", fontFamily: "system-ui, sans-serif" }}>
        <section role="alert" style={{ width: "min(380px, 100%)", textAlign: "center", background: "#161F2F", border: "1px solid #273449", borderRadius: 14, padding: 22 }}>
          <div style={{ fontSize: 42, marginBottom: 8 }}>⚠️</div>
          <h1 style={{ margin: "0 0 8px", fontSize: 20 }}>Ye page abhi load nahi hua</h1>
          <p style={{ margin: "0 0 16px", color: "#AAB4C3", fontSize: 13, lineHeight: 1.5 }}>Screen reload karke dobara try karein. Agar dikkat rahe, internet aur app page check karein.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button type="button" onClick={this.reset} style={{ minHeight: 44, border: "1px solid #475569", borderRadius: 8, background: "transparent", color: "#F8FAFC", fontWeight: 800, cursor: "pointer" }}>Dobara try karo</button>
            <button type="button" onClick={() => window.location.reload()} style={{ minHeight: 44, border: 0, borderRadius: 8, background: "#F97316", color: "#fff", fontWeight: 800, cursor: "pointer" }}>Page reload</button>
          </div>
        </section>
      </main>
    );
  }
}
