/**
 * The popup lists the agents that hold a tab right now, anywhere in the
 * browser. With none, it shows only the extension version.
 */
type Agent = { session: number; name: string; color: string; tabId: number };
type PopupState = {
  ok: boolean;
  version: string;
  hubConnected: boolean;
  hubMismatch: string | null;
  agents: Agent[];
  activeTabHeld: boolean;
};

const agentsEl = document.getElementById("agents") as HTMLUListElement;
const pickEl = document.getElementById("pick") as HTMLButtonElement;
const versionEl = document.getElementById("version") as HTMLParagraphElement;
const versionTextEl = document.getElementById("version-text") as HTMLSpanElement;
const hubDotEl = document.getElementById("hub-dot") as HTMLSpanElement;
let painted = "";

function send<T>(msg: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ target: "sw", ...msg }) as Promise<T>;
}

function paint(state: PopupState): void {
  const key = JSON.stringify(state);
  if (key === painted) return;
  painted = key;

  agentsEl.replaceChildren(
    ...state.agents.map((agent) => {
      const li = document.createElement("li");
      li.className = "agent";
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = agent.color;
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = agent.name;
      li.append(dot, name);
      return li;
    }),
  );
  pickEl.hidden = !state.activeTabHeld;
  versionEl.hidden = state.agents.length > 0;
  versionTextEl.textContent = `browser-mcp ${state.version}`;
  // Agents listed means the hub is connected; the dot matters when idle.
  hubDotEl.classList.toggle("on", state.hubConnected);
  hubDotEl.classList.toggle("bad", !state.hubConnected && state.hubMismatch != null);
  versionEl.title = state.hubConnected
    ? "Connected to the local hub"
    : state.hubMismatch
      ? `Version mismatch: ${state.hubMismatch} An agent can fix it with browser_update_extension.`
      : "No hub running (it starts when an agent uses the browser)";
}

async function refresh(): Promise<void> {
  const state = await send<PopupState>({ type: "popup.state" });
  if (state?.ok) paint(state);
}

pickEl.addEventListener("click", () => {
  void send({ type: "startPicker" }).finally(() => window.close());
});

void refresh();
setInterval(() => void refresh(), 1500);
