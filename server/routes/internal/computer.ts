// Computer surfaces of /api/internal: the computer-selection offer, the
// built-in browser's MCP bridge, shared computers, and the computer-control
// hold. Bodies moved verbatim from ../internal.ts; the dispatch chain there
// owns path matching, methods, and order.
import type { ServerResponse } from "node:http";

import { startAutoVmClaim } from "../../auto-vm-claims.ts";
import { builtInBrowserEnabled, sharedComputersEnabled } from "../../config.ts";
import { blockedTarget, buildNotification } from "../../notify.ts";
import { sharedComputerOperation } from "../../shared-computers.ts";
import { teamComputerOwner } from "../../team-computers.ts";
import { parseSurface, surfaceLabel } from "../../surface.ts";
import type { InternalRoutesOptions } from "../internal.ts";
import type { InternalRequestCtx } from "./types.ts";

export type ComputerCtx = InternalRequestCtx & {
  store: InternalRoutesOptions["store"];
  cfg: InternalRoutesOptions["cfg"];
  browserRuntime: InternalRoutesOptions["browserRuntime"];
  sharedComputers: InternalRoutesOptions["sharedComputers"];
  computerControl: InternalRoutesOptions["computerControl"];
  computerSelectionTurns: InternalRoutesOptions["computerSelectionTurns"];
  turnComputerResources: InternalRoutesOptions["turnComputerResources"];
  autoVmClaims: InternalRoutesOptions["autoVmClaims"];
  browserIntegration: InternalRoutesOptions["browserIntegration"];
  currentBrowserSession: InternalRoutesOptions["currentBrowserSession"];
  botComputerControlSnapshot: InternalRoutesOptions["botComputerControlSnapshot"];
  selectableComputers: InternalRoutesOptions["selectableComputers"];
  computerPreviewSurface: InternalRoutesOptions["computerPreviewSurface"];
  claimTurnResource: InternalRoutesOptions["claimTurnResource"];
  activeGroupTurnForBot: InternalRoutesOptions["activeGroupTurnForBot"];
  notify: InternalRoutesOptions["notify"];
  internalCapabilityIsActive: InternalRoutesOptions["internalCapabilityIsActive"];
}

export async function computerSelect(ctx: ComputerCtx, res: ServerResponse, method: string): Promise<boolean> {
  const {
    store, computerSelectionTurns, selectableComputers, computerPreviewSurface,
    internalCapability, internalSender, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const source = computerSelectionTurns.get(internalCapability.threadId);
    const bot = store.projectBotForTask(internalSender.id, internalCapability.threadId);
    const canSelect = Boolean(source && source.generation === internalCapability.generation && bot && bot.computer !== "off");
    if (!bot) return json(res, 403, { error: "Computer selection belongs to a direct bot conversation." });
    const requested = method === "POST" ? (await readInternalBody()).surface : undefined;
    if (method === "POST" && !canSelect) return json(res, 403, { error: "Computer selection is only available once per direct user request, with computer access enabled." });
    if (method === "POST" && requested !== "auto" && !parseSurface(requested)) {
      return json(res, 400, { error: "surface must be auto, cloud, vm, local, or browser" });
    }
    const options = await selectableComputers(bot);
    const current = source ? source.mounted ?? "off" : await computerPreviewSurface(bot, bot.threadId);
    requireActiveInternalCapability();
    if (method === "GET") return json(res, 200, { current, canSelect, options });
    if (computerSelectionTurns.get(internalCapability.threadId) !== source) return json(res, 409, { error: "The user request ended before its computer was selected." });
    const option = requested === "auto"
      ? options.find(option => option.ready && option.surface === current) ?? options.find(option => option.ready && option.surface === "vm") ?? options.find(option => option.ready) ?? options.find(option => option.canStart) ?? options.find(option => option.canCreate && option.surface === "vm") ?? options.find(option => option.canCreate)
      : options.find(option => option.surface === requested);
    if (!option?.available) return json(res, 409, { error: option?.reason ?? "No configured computer or browser is available. Open the Computer panel to set one up.", options });
    if (source!.selected) {
      if (source!.selected !== option.surface) return json(res, 409, { error: "A computer switch is already pending. End this turn to continue there." });
    } else {
      if (option.surface === current && option.ready) return json(res, 200, { status: "ready", surface: current, message: "This computer is already selected. Use its mounted tools." });
      source!.selected = option.surface;
      source!.previousSurface = store.taskByThread(bot.id, bot.threadId)?.surface;
    }
    return json(res, 200, { status: "pending", surface: option.surface,
      message: `End this turn now without using the previous computer tools. OpenMausBot will continue the original request on ${option.label} with a fresh tool connection.` });
}

export async function browserMcp(ctx: ComputerCtx, res: ServerResponse): Promise<boolean> {
  const {
    store, cfg, browserRuntime, browserIntegration, currentBrowserSession, claimTurnResource,
    internalCapability, json, readInternalBody, requireActiveInternalCapability,
  } = ctx;
    const body = await readInternalBody();
    const bot = store.bot(internalCapability.botId);
    if (!bot || bot.browser === false || bot.computer === "off" || !builtInBrowserEnabled(cfg)) {
      return json(res, 403, { error: "browser tools are not enabled for this bot" });
    }
    const browser = await browserIntegration(bot.id, bot.browserProfile);
    if (!browser || browser.session !== internalCapability.browserSession) {
      return json(res, 409, { error: "this browser profile changed; start a new turn" });
    }
    if (body?.method !== "tools/list" && body?.method !== "tools/call") {
      return json(res, 400, { error: "unsupported browser method" });
    }
    const result = await browserRuntime.agentRpc(browser.session, browser.spec, body.method, body.params, () => {
      requireActiveInternalCapability();
      const current = store.bot(bot.id);
      if (!current || current.browser === false || current.computer === "off" || !builtInBrowserEnabled(cfg) ||
          currentBrowserSession(current.id, current.browserProfile) !== browser.session) {
        throw Object.assign(new Error("Browser access changed while connecting."), { status: 409 });
      }
      if (body.method === "tools/call" && !claimTurnResource(internalCapability, `browser:${browser.session}`)) {
        throw Object.assign(new Error("another thread is using this browser — pause browser work until that thread finishes"), { status: 409 });
      }
    });
    requireActiveInternalCapability();
    return json(res, 200, { result });
}

export async function sharedComputersList(ctx: ComputerCtx, res: ServerResponse): Promise<boolean> {
  const {
    sharedComputers, json,
  } = ctx;
  return json(res, 200, { computers: sharedComputers.list() });
}

export async function sharedComputersSubmit(ctx: ComputerCtx, res: ServerResponse): Promise<boolean> {
  const {
    sharedComputers, cfg, internalCapability, internalCapabilityIsActive, json, readInternalBody,
  } = ctx;
    const parsed = sharedComputerOperation.safeParse(await readInternalBody());
    if (!sharedComputersEnabled(cfg)) return json(res, 404, { error: "unknown internal endpoint" });
    if (!parsed.success) return json(res, 400, { error: "Invalid shared computer operation" });
    return json(res, 200, { result: await sharedComputers.request(parsed.data, () => sharedComputersEnabled(cfg) && internalCapabilityIsActive(internalCapability)) });
}

// ── computer control: proxies read the hold, bots plead for help ──
export async function computerControlRoute(ctx: ComputerCtx, res: ServerResponse, url: URL, method: string): Promise<boolean> {
  const {
    store, computerControl, botComputerControlSnapshot, turnComputerResources, autoVmClaims,
    activeGroupTurnForBot, notify, claimTurnResource, internalCapability, json, readInternalBody,
  } = ctx;
    const botId = url.searchParams.get("botId") ?? "";
    const bot = store.bot(botId);
    if (!bot) return json(res, 404, { error: "no such bot" });
    if (method === "GET") {
      const snapshot = botComputerControlSnapshot(botId, internalCapability.teamComputerId);
      const computer = turnComputerResources.get(internalCapability.threadId);
      const lazyClaim = autoVmClaims.get(internalCapability.threadId);
      if (!snapshot.held && !computer && lazyClaim && lazyClaim.owner.generation === internalCapability.generation) {
        // First screen tools/call on a lazily-attached Auto VM (issue
        // #1361): fire the exclusive claim — once — and answer with the
        // same contention text a dispatched claim produces until it
        // lands. No-op today: dispatch claims eagerly, so a live VM
        // capability always has its computer entry already.
        startAutoVmClaim(autoVmClaims, internalCapability.threadId, internalCapability.generation);
        return json(res, 200, {
          held: true, helpOpen: false,
          blockedReason: "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.",
        });
      }
      if (!snapshot.held && computer && computer.owner.generation === internalCapability.generation &&
          !claimTurnResource(computer.owner, computer.resource)) {
        return json(res, 200, {
          held: true, helpOpen: false,
          blockedReason: "Another thread is using this computer. This call was not performed. Pause computer work until that thread finishes, then take a fresh screenshot before acting.",
        });
      }
      return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
    }
    if (method === "POST") {
      const body = await readInternalBody();
      const controlKey = internalCapability.teamComputerId ? teamComputerOwner(internalCapability.teamComputerId) : botId;
      const { snapshot, requestId } = computerControl.requestHelpLease(controlKey, body.reason);
      // worth a buzz: the bot is blocked on the person's hands, which
      // is exactly the "blocked on you" rule notify.ts encodes.
      // A bot stuck mid-room is not in its 1:1 thread — the turn and the
      // screen it needs hands on are in the room — so send the person
      // where the work is, and say which room it was.
      const roomTurn = activeGroupTurnForBot(bot.id);
      const target = blockedTarget({ ...bot, threadId: internalCapability.threadId }, roomTurn && { ...roomTurn.group, threadId: roomTurn.threadId });
      const helpPlace = store.taskByThread(bot.id, internalCapability.threadId)?.surface ?? bot.computer;
      const helpWhere = helpPlace && helpPlace !== "off" ? ` on ${surfaceLabel(helpPlace)}` : "";
      notify(
        buildNotification("takeover", bot, target.threadId, `${snapshot.helpReason ?? "asked you to take over"}${helpWhere}`, {
          group: target.group,
        }),
      );
      return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null, requestId });
    }
    if (method === "DELETE") {
      const body = await readInternalBody();
      const snapshot = computerControl.expireHelp(internalCapability.teamComputerId ? teamComputerOwner(internalCapability.teamComputerId) : botId, body.requestId);
      return json(res, 200, { held: snapshot.held, helpOpen: snapshot.helpReason !== null });
    }
    return json(res, 405, { error: "method not allowed" });
}
