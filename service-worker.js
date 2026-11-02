import {ALARM_PREFIX, RULES_KEY, TABS_KEY, DEFAULT_INTERVAL, pageOrigin, supportedPage,
  permissionPattern, intervalMinutes, normalizeEndpoint, normalizeRule, effectiveSettings,
  emptyRuntime, recordAttempt, actualInterval, indicatorState, normalizeRuntime, KeeperError} from './core.js';
import {getProfile, profileOperation} from './profiles.js';
import {t, localizeRuntime} from './i18n.js';

const token = () => crypto.randomUUID();
const safeErrorName = error => ['Error', 'TypeError', 'RangeError', 'DOMException', 'AbortError'].includes(error?.name) ? error.name : 'Error';
const configKey = effective => JSON.stringify({enabled: effective.enabled,
  intervalMinutes: effective.intervalMinutes, endpoint: effective.endpoint});
const resetRuntime = (runtime, clearProfile = false) => ({...emptyRuntime(),
  lastAttemptAt: runtime?.lastAttemptAt ?? null, attempts: runtime?.attempts || [],
  profile: clearProfile ? null : runtime?.profile ?? null});

export function createKeeper(api, {now = Date.now} = {}) {
  let queue = Promise.resolve();
  const knownEnabled = new Set();
  const locked = work => {
    const result = queue.then(work, work);
    queue = result.catch(() => {});
    return result;
  };
  const read = async () => {
    const [local, session] = await Promise.all([api.storage.local.get(RULES_KEY), api.storage.session.get(TABS_KEY)]);
    const rules = (Array.isArray(local[RULES_KEY]) ? local[RULES_KEY] : []).flatMap(rule => {
      try { return [normalizeRule(rule)]; } catch { return []; }
    });
    const records = session[TABS_KEY] || {};
    for (const record of Object.values(records)) record.runtime = normalizeRuntime(record.runtime);
    return {rules, records};
  };
  const saveRecords = async records => {
    const current = await api.storage.session.get(TABS_KEY);
    if (JSON.stringify(current[TABS_KEY] || {}) !== JSON.stringify(records)) await api.storage.session.set({[TABS_KEY]: records});
  };
  const hasPermission = async origin => {
    try { return await api.permissions.contains({origins: [permissionPattern(origin)]}); }
    catch { return false; }
  };
  const alarmName = id => `${ALARM_PREFIX}${id}`;
  const tabById = async id => { try { return await api.tabs.get(id); } catch { return null; } };
  const restore = async (tabId, record) => {
    if (typeof record?.previousAutoDiscardable === 'boolean') {
      try { await api.tabs.update(tabId, {autoDiscardable: record.previousAutoDiscardable}); } catch {}
      delete record.previousAutoDiscardable;
    }
  };
  const badge = async (tabId, enabled, runtime = emptyRuntime()) => {
    if (enabled) knownEnabled.add(tabId); else knownEnabled.delete(tabId);
    const {iconState, warning} = indicatorState(enabled, runtime, now());
    const badgeText = warning ? '!' : iconState === 'on' ? t('badgeActive', [], api) : '';
    const paths = Object.fromEntries([16, 24, 32, 48, 128].map(size => [size, `icons/${iconState}${size}.png`]));
    await Promise.allSettled([
      api.action.setIcon({tabId, path: paths}),
      api.action.setBadgeText({tabId, text: badgeText}),
      api.action.setBadgeBackgroundColor({tabId, color: '#ba393c'}),
      api.action.setTitle({tabId, title: enabled ? `Tab Session Keeper · ${localizeRuntime(runtime, api).message}` : t('actionTitle', [], api)}),
    ]);
  };

  async function reconcileLocked(state = null, navigationTabId = null) {
    const {rules, records} = state || await read();
    const tabs = await api.tabs.query({});
    const living = new Set(tabs.map(tab => String(tab.id)));
    for (const [key, record] of Object.entries(records)) {
      if (!living.has(key)) {
        await api.alarms.clear(alarmName(Number(key)));
        delete records[key];
      }
    }
    for (const tab of tabs) {
      if (!Number.isInteger(tab.id)) continue;
      let record = records[tab.id];
      const origin = supportedPage(tab.url) ? pageOrigin(tab.url) : null;
      if (record && origin !== record.origin) {
        // A revoked persistent host grant can hide the tab URL. Keep its rule, never send blindly.
        const missingGrant = !origin && rules.some(rule => rule.origin === record.origin && rule.enabled) &&
          !await hasPermission(record.origin);
        if (missingGrant) {
          if (record.runtime.status !== 'permission' || record.inFlight) record.generation = token();
          record.runtime = {...record.runtime, status: 'permission', messageKey: 'runtimePermissionMissing', messageArgs: [], nextAttemptAt: null};
          delete record.inFlight;
          await api.alarms.clear(alarmName(tab.id));
          await restore(tab.id, record);
          await badge(tab.id, true, record.runtime);
          continue;
        }
        await restore(tab.id, record);
        await api.alarms.clear(alarmName(tab.id));
        delete records[tab.id];
        record = null;
      }
      const effective = effectiveSettings(origin, record, rules);
      if (!effective.enabled || !origin) {
        if (record) {
          await restore(tab.id, record);
          if (record.inFlight || record.runtime.status !== 'idle') record.generation = token();
          record.runtime = resetRuntime(record.runtime);
          record.needsFirstRun = false;
          delete record.inFlight;
          if (!record.override) delete records[tab.id];
        }
        await api.alarms.clear(alarmName(tab.id));
        await badge(tab.id, false);
        continue;
      }
      const signature = configKey(effective);
      if (!record) record = records[tab.id] = {origin, runtime: emptyRuntime(), generation: token(), needsFirstRun: true};
      if (record.signature !== signature) {
        record.signature = signature;
        record.runtime = resetRuntime(record.runtime, Boolean(effective.endpoint));
        record.generation = token();
        record.needsFirstRun = true;
        delete record.inFlight;
        await api.alarms.clear(alarmName(tab.id));
      }
      if (effective.source === 'site' && !await hasPermission(origin)) {
        if (record.runtime.status !== 'permission' || record.inFlight) record.generation = token();
        delete record.inFlight;
        record.runtime = {...record.runtime, status: 'permission', messageKey: 'runtimePermissionMissing', messageArgs: [], nextAttemptAt: null};
        await api.alarms.clear(alarmName(tab.id));
        await restore(tab.id, record);
        await badge(tab.id, true, record.runtime);
        continue;
      }
      if (record.runtime.status === 'permission') {
        record.runtime = resetRuntime(record.runtime);
        record.needsFirstRun = true;
      }
      const scheduledInterval = actualInterval(effective, record.runtime, tab.url);
      record.runtime.actualIntervalMinutes = scheduledInterval;
      if (typeof record.previousAutoDiscardable !== 'boolean') record.previousAutoDiscardable = tab.autoDiscardable !== false;
      if (tab.autoDiscardable !== false) {
        try { await api.tabs.update(tab.id, {autoDiscardable: false}); } catch {}
      }
      if (record.runtime.status === 'paused') {
        await api.alarms.clear(alarmName(tab.id));
        record.runtime.nextAttemptAt = null;
        await badge(tab.id, true, record.runtime);
        continue;
      }
      const waiting = tab.status !== 'complete' || tab.discarded || tab.frozen;
      if (waiting) record.runtime = {...record.runtime, status: 'waiting', messageKey: 'runtimeWaitingDocument', messageArgs: [], waitReason: 'document'};
      else if (record.runtime.status === 'waiting' && (!record.runtime.waitReason || record.runtime.waitReason === 'document')) record.runtime = {...record.runtime, status: 'idle', messageKey: 'runtimeIdle', messageArgs: [], waitReason: null};
      if (!waiting && tab.id === navigationTabId && !effective.endpoint) {
        record.needsFirstRun = true;
        record.generation = token();
        delete record.inFlight;
      }
      try {
        let alarm = await api.alarms.get(alarmName(tab.id));
        if (!alarm || alarm.periodInMinutes !== scheduledInterval) {
          await api.alarms.create(alarmName(tab.id), {periodInMinutes: scheduledInterval});
          alarm = await api.alarms.get(alarmName(tab.id));
        }
        record.runtime.nextAttemptAt = alarm?.scheduledTime ?? now() + scheduledInterval * 60000;
      } catch (error) {
        record.runtime = recordAttempt(record.runtime, {kind: 'scheduler-error', method: null, errorName: safeErrorName(error)}, now());
        record.runtime.nextAttemptAt = null;
      }
      await badge(tab.id, true, record.runtime);
    }
    await saveRecords(records);
    // Remove orphaned alarms after browser restart, when storage.session has been cleared.
    const alarms = await api.alarms.getAll();
    for (const alarm of alarms) {
      if (alarm.name.startsWith(ALARM_PREFIX) && !records[alarm.name.slice(ALARM_PREFIX.length)]) await api.alarms.clear(alarm.name);
    }
    const readyIds = tabs.filter(tab => {
      const record = records[tab.id];
      return record?.needsFirstRun && effectiveSettings(record.origin, record, rules).enabled &&
        !['paused', 'permission'].includes(record.runtime.status) && tab.status === 'complete' && !tab.discarded && !tab.frozen;
    }).map(tab => tab.id);
    return {rules, records, tabs, readyIds};
  }

  async function runTab(tabId) {
    const claim = await locked(async () => {
      const {rules, records} = await read();
      const tab = await tabById(tabId);
      const record = records[tabId];
      const origin = pageOrigin(tab?.url);
      const effective = effectiveSettings(origin, record, rules);
      if (!tab || !record || !effective.enabled || record.origin !== origin) return null;
      if (record.runtime.status === 'paused') return null;
      if (effective.source === 'site' && !await hasPermission(origin)) {
        await reconcileLocked({rules, records});
        return null;
      }
      if (record.inFlight?.until > now()) return null;
      if (tab.status !== 'complete' || tab.discarded || tab.frozen) {
        record.runtime = {...record.runtime, status: 'waiting', messageKey: 'runtimeWaitingDocument', messageArgs: [], waitReason: 'document'};
        await saveRecords(records);
        await badge(tabId, true, record.runtime);
        return null;
      }
      const attemptId = token();
      record.inFlight = {id: attemptId, until: now() + 20000};
      record.needsFirstRun = false;
      record.runtime.lastAttemptAt = now();
      const alarm = await api.alarms.get(alarmName(tabId));
      const scheduledInterval = actualInterval(effective, record.runtime, tab.url);
      record.runtime.actualIntervalMinutes = scheduledInterval;
      record.runtime.nextAttemptAt = alarm?.scheduledTime > now() ? alarm.scheduledTime : now() + scheduledInterval * 60000;
      await saveRecords(records);
      return {origin, endpoint: effective.endpoint, generation: record.generation, attemptId};
    });
    if (!claim) return {ok: true};
    let result;
    try {
      const probe = await api.scripting.executeScript({target: {tabId, frameIds: [0]}, world: 'ISOLATED',
        func: profileOperation, args: [claim.origin, claim.endpoint, 'auto', true]});
      const detected = probe[0]?.result;
      if (detected?.kind !== 'detected') result = detected || {kind: 'waiting'};
      else {
        const profile = getProfile(detected.profile);
        const outputs = await api.scripting.executeScript({target: {tabId, frameIds: [0]}, world: profile.world,
          func: profileOperation, args: [claim.origin, claim.endpoint, profile.id, false]});
        result = outputs[0]?.result ?? {kind: 'waiting', profile: profile.id};
      }
    } catch (error) {
      result = {kind: 'injection-error', code: /permission|cannot access|not allowed/i.test(String(error?.message)) ? 'permission' : 'unavailable', errorName: safeErrorName(error)};
    }
    await locked(async () => {
      const {rules, records} = await read();
      const record = records[tabId];
      const currentTab = await tabById(tabId);
      if (!record || record.generation !== claim.generation || record.inFlight?.id !== claim.attemptId ||
        pageOrigin(currentTab?.url) !== claim.origin) return;
      delete record.inFlight;
      record.runtime = recordAttempt(record.runtime, result, now());
      if (record.runtime.status === 'paused') {
        record.runtime.nextAttemptAt = null;
        await api.alarms.clear(alarmName(tabId));
      }
      await saveRecords(records);
      await reconcileLocked({rules, records});
    });
    return {ok: true};
  }

  async function message(request) {
    if (!request || typeof request.type !== 'string') return errorResponse('errorInvalidRequest');
    try {
      if (request.type === 'testNow') {
        const state = await locked(() => reconcileLocked());
        const record = state.records[request.tabId];
        if (!record || !effectiveSettings(record.origin, record, state.rules).enabled) throw new KeeperError('errorTabInactive');
        if (record.runtime.status === 'paused') throw new KeeperError('errorTabPaused');
        return await runTab(request.tabId);
      }
      const response = await locked(async () => {
        let {rules, records} = await read();
        if (request.type === 'getState') {
          const tab = Number.isInteger(request.tabId) ? await tabById(request.tabId)
            : (await api.tabs.query({active: true, currentWindow: true}))[0] ?? null;
          const origin = pageOrigin(tab?.url);
          const record = tab ? records[tab.id] : null;
          const effective = effectiveSettings(origin, record, rules);
          const enrichedRules = await Promise.all(rules.map(async rule => ({...rule, hasPermission: await hasPermission(rule.origin)})));
          return {ok: true,
            tab: tab ? {id: tab.id, title: tab.title || '', url: tab.url || '', origin,
              supported: supportedPage(tab.url)} : null,
            effective: {...effective, hasOverride: Boolean(record?.override), ...indicatorState(effective.enabled, record?.runtime, now())},
            runtime: localizeRuntime(record?.runtime || emptyRuntime(), api), rules: enrichedRules};
        }
        const beforeTabs = await api.tabs.query({});
        const before = new Map(beforeTabs.map(tab => [tab.id, effectiveSettings(pageOrigin(tab.url), records[tab.id], rules)]));
        if (request.type === 'saveRule') {
          const rule = normalizeRule(request.rule);
          if (rule.enabled && !await hasPermission(rule.origin)) throw new KeeperError('errorPermissionRequired');
          rules = [...rules.filter(item => item.origin !== rule.origin), rule].sort((a, b) => a.origin.localeCompare(b.origin));
          await api.storage.local.set({[RULES_KEY]: rules});
          if (Number.isInteger(request.tabId) && records[request.tabId]?.origin === rule.origin) {
            delete records[request.tabId].override;
          }
        } else if (request.type === 'deleteRule') {
          rules = rules.filter(item => item.origin !== request.origin);
          await api.storage.local.set({[RULES_KEY]: rules});
        } else if (['setTab', 'clearTabOverride', 'resumeTab'].includes(request.type)) {
          const tab = await tabById(request.tabId);
          if (!tab || !supportedPage(tab.url)) throw new KeeperError('errorUnsupportedTab');
          const origin = pageOrigin(tab.url);
          let record = records[tab.id];
          if (record?.origin !== origin) {
            await restore(tab.id, record);
            record = null;
          }
          record ||= records[tab.id] = {origin, runtime: emptyRuntime(), generation: token()};
          if (request.type === 'setTab') record.override = {
            enabled: request.enabled === true,
            intervalMinutes: intervalMinutes(request.intervalMinutes ?? record.override?.intervalMinutes ?? DEFAULT_INTERVAL),
            endpoint: normalizeEndpoint(request.endpoint ?? record.override?.endpoint ?? '', origin),
          };
          else if (request.type === 'clearTabOverride') delete record.override;
          else if (request.type === 'resumeTab') {
            record.generation = token();
            record.runtime = resetRuntime(record.runtime);
            record.needsFirstRun = true;
            delete record.inFlight;
          }
          // Explicit resume preserves the user's selected scope and configuration.
        } else throw new KeeperError('errorUnknownAction');
        for (const tab of beforeTabs) {
          const after = effectiveSettings(pageOrigin(tab.url), records[tab.id], rules);
          if (after.enabled && configKey(before.get(tab.id)) !== configKey(after) && records[tab.id]) records[tab.id].needsFirstRun = true;
        }
        await saveRecords(records);
        const state = await reconcileLocked({rules, records});
        return {ok: true, immediateIds: state.readyIds};
      });
      if (response.immediateIds) {
        await Promise.all(response.immediateIds.map(runTab));
        delete response.immediateIds;
      }
      return response;
    } catch (error) { return errorResponse(error?.errorKey || 'errorActionFailed', error?.errorArgs || []); }
  }

  function errorResponse(errorKey, errorArgs = []) {
    return {ok: false, errorKey, errorArgs, error: t(errorKey, errorArgs, api)};
  }

  const reconcile = async ({runPending = false, navigationTabId = null} = {}) => {
    const state = await locked(() => reconcileLocked(null, navigationTabId));
    if (runPending) await Promise.all(state.readyIds.map(runTab));
    return state;
  };
  async function init() {
    await api.action.setBadgeText({text: ''});
    await api.storage.local.setAccessLevel?.({accessLevel: 'TRUSTED_CONTEXTS'});
    return reconcile({runPending: true});
  }
  function register() {
    api.runtime.onMessage.addListener((request, sender, sendResponse) => {
      // Only extension UI pages can issue commands; no externally supplied fetch URLs.
      if (sender.id !== api.runtime.id || !sender.url?.startsWith(api.runtime.getURL(''))) {
        sendResponse(errorResponse('errorUnauthorizedSender'));
        return false;
      }
      message(request).then(sendResponse, () => sendResponse(errorResponse('errorInternal')));
      return true;
    });
    const reportFailure = async (error, tabId = null) => {
      console.warn('Tab Session Keeper: background operation failed.', {name: safeErrorName(error)});
      const runtime = {...emptyRuntime(), status: 'error', messageKey: 'runtimeSchedulerError', nextAttemptAt: null};
      const stored = await api.storage.session.get(TABS_KEY).catch(() => ({}));
      const ids = new Set([...knownEnabled, ...Object.entries(stored[TABS_KEY] || {})
        .filter(([, record]) => record.override?.enabled !== false).map(([id]) => Number(id))]);
      const affected = Number.isInteger(tabId) ? [...ids].filter(id => id === tabId) : [...ids];
      await Promise.allSettled(affected.map(id => badge(id, true, runtime)));
    };
    const refresh = () => { reconcile({runPending: true}).catch(reportFailure); };
    api.runtime.onStartup.addListener(refresh);
    api.runtime.onInstalled.addListener(refresh);
    api.tabs.onCreated.addListener(refresh);
    api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      const navigation = changeInfo.status === 'complete' || (changeInfo.url && tab.status === 'complete');
      reconcile({runPending: true, navigationTabId: navigation ? tabId : null}).catch(error => reportFailure(error, tabId));
    });
    api.tabs.onRemoved.addListener(refresh);
    api.tabs.onReplaced.addListener(refresh);
    api.permissions.onAdded.addListener(refresh);
    api.permissions.onRemoved.addListener(refresh);
    api.alarms.onAlarm.addListener(alarm => {
      if (alarm.name.startsWith(ALARM_PREFIX)) {
        const tabId = Number(alarm.name.slice(ALARM_PREFIX.length));
        runTab(tabId).catch(error => reportFailure(error, tabId));
      }
    });
    init().catch(reportFailure);
  }
  return {message, reconcile, runTab, init, register};
}

if (globalThis.chrome?.runtime?.id) createKeeper(globalThis.chrome).register();
