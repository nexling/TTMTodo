import { chainSize, type ConnectedChainState, type ConnectedIds } from "../planConnected";

export function ShowConnectedBanner(props: { hiddenCount: number; onDismiss: () => void }) {
  const hidden =
    props.hiddenCount > 0
      ? ` — ${props.hiddenCount} hidden`
      : "";
  return (
    <div className="plan-connected-banner" role="status">
      <div className="plan-connected-banner-copy">
        <strong>Showing connections</strong>
        {hidden ? <span className="hint">{hidden}</span> : null}
        <span className="plan-connected-key" aria-hidden="true">
          <span className="plan-connected-swatch source" />
          This task
          <span className="plan-connected-swatch upstream" />
          Depends on
          <span className="plan-connected-swatch following" />
          Depending
        </span>
      </div>
      <button className="btn ghost small" type="button" onClick={props.onDismiss} aria-label="Hide connections">
        Hide
      </button>
    </div>
  );
}

export function ShowConnectedMenuItem(props: {
  isSource: boolean;
  chain: ConnectedChainState;
  onShow: (chain: ConnectedIds) => void;
  onHide: () => void;
}) {
  if (props.isSource) {
    return (
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          props.onHide();
        }}
      >
        Hide connections
      </button>
    );
  }
  const chain = props.chain;
  if (chain === "loading" || chain === "error") {
    return (
      <button type="button" className="menu-item" disabled>
        Show Connected
      </button>
    );
  }
  const empty = chainSize(chain) === 0;
  return (
    <button
      type="button"
      className="menu-item"
      disabled={empty}
      onClick={() => {
        if (empty) return;
        props.onShow(chain);
      }}
    >
      Show Connected
    </button>
  );
}
