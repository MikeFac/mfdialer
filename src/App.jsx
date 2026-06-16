import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TelnyxRTC } from '@telnyx/webrtc';
import Papa from 'papaparse';
import {
  BarChart3,
  Ban,
  BookUser,
  ChevronLeft,
  Download,
  Headphones,
  History,
  Link,
  ListChecks,
  Merge,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Upload,
} from 'lucide-react';

const terminalCallStates = new Set(['done', 'hangup', 'destroy', 'purge', 9, 10, 11]);
const playableCallStates = new Set(['early', 'active', 6, 7]);
const audioOutputStorageKey = 'telnyx-dialer-audio-output';
const microphoneStorageKey = 'telnyx-dialer-microphone';
const e164Pattern = /^\+[1-9]\d{1,14}$/;
const callStateLabels = {
  0: 'New',
  1: 'Requesting',
  2: 'Trying',
  3: 'Recovering',
  4: 'Ringing',
  5: 'Answering',
  6: 'Early',
  7: 'Active',
  8: 'Held',
  9: 'Hangup',
  10: 'Destroy',
  11: 'Purge',
};

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { id: 'dialer', label: 'Dialer', icon: Phone },
  { id: 'campaigns', label: 'Campaigns', icon: ListChecks },
  { id: 'contacts', label: 'Contacts', icon: BookUser },
  { id: 'dnc', label: 'DNC', icon: Ban },
  { id: 'history', label: 'Call history', icon: History },
  { id: 'integrations', label: 'Integrations', icon: Link },
];

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== ''),
  );
}

function getCallState(call) {
  return call?.state || call?.status || 'active';
}

function getCallStateLabel(call) {
  const state = getCallState(call);

  return callStateLabels[state] || state;
}

function summarizeCall(call) {
  if (!call) return {};

  return compactObject({
    id: call.id,
    state: getCallStateLabel(call),
    rawState: getCallState(call),
    previousState: call.prevState,
    direction: call.direction,
    destinationNumber: call.options?.destinationNumber,
    callerNumber: call.options?.callerNumber,
    cause: call.cause,
    causeCode: call.causeCode,
    sipCode: call.sipCode,
    sipReason: call.sipReason,
    telnyxCallControlId: call.telnyxIDs?.telnyxCallControlId,
    telnyxSessionId: call.telnyxIDs?.telnyxSessionId,
    telnyxLegId: call.telnyxIDs?.telnyxLegId,
  });
}

function isNormalCallClearing(call) {
  return call?.causeCode === 16 || call?.cause === 'NORMAL_CLEARING';
}

function hasCallFailure(call) {
  return Boolean(
    call?.sipCode >= 400 ||
      (!isNormalCallClearing(call) && (call?.cause || call?.causeCode || call?.sipReason)),
  );
}

function formatCallFailure(call) {
  if (call?.sipCode && call?.sipReason) return `Call failed: ${call.sipCode} ${call.sipReason}`;
  if (call?.sipReason) return `Call failed: ${call.sipReason}`;
  if (call?.cause) return `Call ended: ${call.cause}`;
  return 'Call failed.';
}

function getNestedError(payload) {
  return payload?.error || payload?.warning || payload?.originalError || payload;
}

function getErrorMessage(payload, fallback) {
  const error = getNestedError(payload);

  return (
    error?.message ||
    error?.description ||
    payload?.message ||
    payload?.reason ||
    payload?.sipReason ||
    payload?.cause ||
    fallback
  );
}

function getSerializableError(payload) {
  const error = getNestedError(payload);

  return compactObject({
    message: getErrorMessage(payload, 'Unknown error'),
    name: error?.name || payload?.name,
    code: error?.code || payload?.code,
    description: error?.description || payload?.description,
    type: payload?.type,
    sessionId: payload?.sessionId,
    cause: payload?.cause || error?.cause,
    causeCode: payload?.causeCode || error?.causeCode,
    sipCode: payload?.sipCode,
    sipReason: payload?.sipReason,
  });
}

function formatMs(value) {
  return Number.isFinite(value) ? `${Math.round(value)} ms` : 'unknown';
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : 'unknown';
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function summarizeAudioTracks(stream) {
  return (stream?.getAudioTracks?.() || []).map((track) => ({
    id: track.id,
    label: track.label || 'unlabeled',
    enabled: track.enabled,
    muted: track.muted,
    readyState: track.readyState,
  }));
}

function getPeerConnection(call) {
  return call?.peer?.instance || call?.peer || null;
}

function getStat(report, id) {
  return id ? report.get(id) : null;
}

function getSelectedCandidatePair(stats) {
  const pairs = stats.filter((stat) => stat.type === 'candidate-pair');

  return (
    pairs.find((pair) => pair.selected) ||
    pairs.find((pair) => pair.nominated && pair.state === 'succeeded') ||
    pairs.find((pair) => pair.state === 'succeeded') ||
    null
  );
}

function getAudioStats(stats) {
  const inbound = stats.find(
    (stat) => stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio'),
  );
  const outbound = stats.find(
    (stat) => stat.type === 'outbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio'),
  );
  const remoteInbound = stats.find(
    (stat) => stat.type === 'remote-inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio'),
  );

  return { inbound, outbound, remoteInbound };
}

function getCodecLabel(report, stat) {
  const codec = getStat(report, stat?.codecId);
  if (!codec) return 'unknown';
  return `${codec.mimeType || codec.mime || 'unknown'}${codec.clockRate ? `/${codec.clockRate}` : ''}`;
}

function getIceLabel(report, pair) {
  const local = getStat(report, pair?.localCandidateId);
  const remote = getStat(report, pair?.remoteCandidateId);
  if (!pair || !local || !remote) return 'unknown';
  return `${local.candidateType || 'local'} -> ${remote.candidateType || 'remote'} (${pair.state})`;
}

function getNetworkQuality({ jitterMs, packetLossPercent, rttMs }) {
  const reasons = [];

  if (![jitterMs, packetLossPercent, rttMs].some(Number.isFinite)) {
    return { label: 'Waiting', reasons: ['Waiting for WebRTC stats'] };
  }

  if (packetLossPercent > 5) reasons.push('high packet loss');
  if (jitterMs > 50) reasons.push('high jitter');
  if (rttMs > 500) reasons.push('very high latency');

  if (reasons.length > 0) return { label: 'Poor', reasons };

  if (packetLossPercent > 2) reasons.push('some packet loss');
  if (jitterMs > 30) reasons.push('some jitter');
  if (rttMs > 300) reasons.push('high latency');

  if (reasons.length > 0) return { label: 'Fair', reasons };

  if (rttMs > 150) reasons.push('moderate latency');

  return { label: 'Good', reasons };
}

function getSavedDeviceId(storageKey) {
  try {
    return localStorage.getItem(storageKey) || '';
  } catch {
    return '';
  }
}

function saveDeviceId(storageKey, deviceId) {
  try {
    localStorage.setItem(storageKey, deviceId);
  } catch {
    // Selected device still applies for the current page load.
  }
}

function getDeviceLabel(device, index, fallbackLabel) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return `Default ${fallbackLabel.toLowerCase()}`;
  if (device.deviceId === 'communications') return `Default communications ${fallbackLabel.toLowerCase()}`;
  return `${fallbackLabel} ${index + 1}`;
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function downloadCsv(url, filename) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function App({ authHeader, userMenu }) {
  const [view, setView] = useState('dialer');
  const [me, setMe] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [campaignReport, setCampaignReport] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [suppressions, setSuppressions] = useState([]);
  const [callAttempts, setCallAttempts] = useState([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState('');
  const [currentQueueMember, setCurrentQueueMember] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState('+19712480206');
  const [recordingRequested, setRecordingRequested] = useState(false);
  const [recordingConsentChecked, setRecordingConsentChecked] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [callStatus, setCallStatus] = useState('Idle');
  const [message, setMessage] = useState('');
  const [error, setError] = useState(null);
  const [microphones, setMicrophones] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [selectedMicrophone, setSelectedMicrophone] = useState(getSavedDeviceId(microphoneStorageKey));
  const [selectedSpeaker, setSelectedSpeaker] = useState(getSavedDeviceId(audioOutputStorageKey));
  const [micLevel, setMicLevel] = useState(0);
  const [micTestActive, setMicTestActive] = useState(false);
  const [diagnostics, setDiagnostics] = useState({
    network: 'Idle',
    audio: 'Idle',
    codec: 'Unknown',
    ice: 'Unknown',
    details: '',
  });
  const [campaignForm, setCampaignForm] = useState({ name: '', description: '', recordingDefault: 'off' });
  const [contactForm, setContactForm] = useState({
    businessName: '',
    contactName: '',
    phoneNumbers: '',
    email: '',
    website: '',
    notes: '',
  });
  const [dncForm, setDncForm] = useState({ phoneNumber: '', reason: '' });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [campaignMembers, setCampaignMembers] = useState([]);
  const [selectedContactId, setSelectedContactId] = useState(null);
  const [contactDetail, setContactDetail] = useState(null);
  const [callOutcome, setCallOutcome] = useState({ outcome: '', notes: '', doNotCall: false, callbackDueAt: '', callbackNote: '' });
  const [editingContact, setEditingContact] = useState(false);
  const [contactSearch, setContactSearch] = useState('');
  const [contactEditForm, setContactEditForm] = useState({});
  const [duplicateGroups, setDuplicateGroups] = useState(null);
  const [merging, setMerging] = useState(false);
  const [webhookEndpoints, setWebhookEndpoints] = useState([]);
  const [webhookEvents, setWebhookEvents] = useState([]);
  const [webhookForm, setWebhookForm] = useState({ name: '', url: '', secret: '', active: true, subscriptions: [] });
  const [showWebhookForm, setShowWebhookForm] = useState(false);
  const [editingWebhookId, setEditingWebhookId] = useState(null);

  const clientRef = useRef(null);
  const activeCallRef = useRef(null);
  const callAttemptRef = useRef(null);
  const isReadyRef = useRef(false);
  const isConnectingRef = useRef(false);
  const connectPromiseRef = useRef(null);
  const connectResolveRef = useRef(null);
  const connectRejectRef = useRef(null);
  const remoteMediaRef = useRef(null);
  const diagnosticsTimerRef = useRef(null);
  const micTestRef = useRef(null);

  const selectedCampaign = campaigns.find((campaign) => campaign.id === selectedCampaignId);
  const dialContact = currentQueueMember?.contact || null;
  const dialPhoneOptions = dialContact?.phoneNumbers || [];

  const api = useCallback(
    async (path, options = {}) => {
      const headers = {
        'Content-Type': 'application/json',
        ...(await authHeader()),
        ...(options.headers || {}),
      };
      const response = await fetch(path, { ...options, headers });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        const requestError = new Error(body.error || `Request failed: ${response.status}`);
        requestError.body = body;
        requestError.status = response.status;
        throw requestError;
      }

      return body;
    },
    [authHeader],
  );

  const reportError = useCallback((summary, payload) => {
    const details = getSerializableError(payload);
    const messageText = getErrorMessage(payload, summary);

    console.error(`[Dialer] ${summary}`, payload);
    setMessage(messageText);
    setError({ summary, details });
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const loadData = useCallback(async () => {
    const [meBody, dashboardBody, campaignsBody, contactsBody, suppressionsBody, callAttemptsBody] =
      await Promise.all([
        api('/api/me'),
        api('/api/dashboard'),
        api('/api/campaigns'),
        api('/api/contacts'),
        api('/api/suppressions'),
        api('/api/call-attempts'),
      ]);

    setMe(meBody);
    setDashboard(dashboardBody);
    setCampaigns(campaignsBody.campaigns || []);
    setContacts(contactsBody.contacts || []);
    setSuppressions(suppressionsBody.suppressions || []);
    setCallAttempts(callAttemptsBody.callAttempts || []);

    try {
      const [whBody, evBody] = await Promise.all([
        api('/api/webhooks'),
        api('/api/webhooks/events'),
      ]);
      setWebhookEndpoints(whBody.endpoints || []);
      setWebhookEvents(evBody.events || []);
    } catch {
      setWebhookEndpoints([]);
      setWebhookEvents([]);
    }
  }, [api]);

  useEffect(() => {
    loadData().catch((loadError) => reportError('Unable to load app data', loadError));
  }, [loadData, reportError]);

  const loadCampaignMembers = useCallback(async () => {
    if (!selectedCampaignId) {
      setCampaignMembers([]);
      setCampaignReport(null);
      return;
    }
    try {
      const [membersBody, reportBody] = await Promise.all([
        api(`/api/campaigns/${selectedCampaignId}/members`),
        api(`/api/reports/campaign/${selectedCampaignId}`),
      ]);
      setCampaignMembers(membersBody.members || []);
      setCampaignReport(reportBody);
    } catch {
      setCampaignMembers([]);
      setCampaignReport(null);
    }
  }, [api, selectedCampaignId]);

  useEffect(() => {
    loadCampaignMembers();
  }, [loadCampaignMembers]);

  const loadContactDetail = useCallback(async () => {
    if (!selectedContactId) {
      setContactDetail(null);
      return;
    }
    try {
      const body = await api(`/api/contacts/${selectedContactId}`);
      setContactDetail(body);
    } catch {
      setContactDetail(null);
    }
  }, [api, selectedContactId]);

  useEffect(() => {
    loadContactDetail();
  }, [loadContactDetail]);

  useEffect(() => {
    if (contactDetail?.contact) {
      const c = contactDetail.contact;
      setContactEditForm({
        businessName: c.businessName || '',
        contactName: c.contactName || '',
        email: c.email || '',
        website: c.website || '',
        address: c.address || '',
        city: c.city || '',
        state: c.state || '',
        status: c.status || 'new',
        doNotCall: c.doNotCall || false,
        notes: c.notes || '',
      });
      setEditingContact(false);
    }
  }, [contactDetail]);

  const submitCallOutcome = useCallback(
    async (callAttemptId, contactId) => {
      try {
        await api(`/api/call-attempts/${callAttemptId}/outcome`, {
          method: 'POST',
          body: JSON.stringify({
            outcome: callOutcome.outcome || undefined,
            notes: callOutcome.notes || undefined,
            doNotCall: callOutcome.doNotCall || undefined,
            callbackDueAt: callOutcome.callbackDueAt || undefined,
            callbackNote: callOutcome.callbackNote || undefined,
            contactId,
          }),
        });
        setCallOutcome({ outcome: '', notes: '', doNotCall: false, callbackDueAt: '', callbackNote: '' });
        callAttemptRef.current = null;
        await loadData();
        if (selectedContactId) await loadContactDetail();
        if (selectedCampaignId) {
          const body = await api(`/api/campaigns/${selectedCampaignId}/queue/next`);
          setCurrentQueueMember(body.member);
          const firstNumber = body.member?.contact?.phoneNumbers?.[0]?.normalizedNumber;
          if (firstNumber) setPhoneNumber(firstNumber);
          setRecordingRequested(body.member?.campaign?.recordingDefault === 'on');
          setMessage(body.member ? `Loaded ${body.member.contact.businessName}.` : 'No more queued contacts.');
        }
      } catch (outcomeError) {
        reportError('Unable to save call outcome', outcomeError);
      }
    },
    [api, callOutcome, loadData, loadContactDetail, reportError, selectedCampaignId, selectedContactId],
  );

  const findDuplicates = useCallback(async () => {
    try {
      const body = await api('/api/contacts/duplicates');
      setDuplicateGroups(body);
    } catch (err) {
      reportError('Unable to find duplicates', err);
    }
  }, [api, reportError]);

  const mergeContacts = useCallback(
    async (primaryId, mergeIds) => {
      try {
        setMerging(true);
        await api('/api/contacts/merge', {
          method: 'POST',
          body: JSON.stringify({ primaryId, mergeIds }),
        });
        setDuplicateGroups(null);
        await loadData();
        if (selectedContactId) await loadContactDetail();
        setMessage(`Merged ${mergeIds.length} contacts.`);
      } catch (err) {
        reportError('Unable to merge contacts', err);
      } finally {
        setMerging(false);
      }
    },
    [api, loadData, loadContactDetail, reportError, selectedContactId],
  );

  const loadWebhooks = useCallback(async () => {
    try {
      const [whBody, evBody] = await Promise.all([
        api('/api/webhooks'),
        api('/api/webhooks/events'),
      ]);
      setWebhookEndpoints(whBody.endpoints || []);
      setWebhookEvents(evBody.events || []);
    } catch (err) {
      reportError('Unable to load webhooks', err);
    }
  }, [api, reportError]);

  const saveWebhook = useCallback(async () => {
    try {
      const body = editingWebhookId
        ? await api(`/api/webhooks/${editingWebhookId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: webhookForm.name,
              url: webhookForm.url,
              secret: webhookForm.secret || undefined,
              active: webhookForm.active,
            }),
          })
        : await api('/api/webhooks', {
            method: 'POST',
            body: JSON.stringify(webhookForm),
          });

      const saved = body.endpoint;
      if (editingWebhookId) {
        setWebhookEndpoints((prev) => prev.map((ep) => (ep.id === saved.id ? { ...ep, ...saved } : ep)));
      } else {
        setWebhookEndpoints((prev) => [saved, ...prev]);
      }

      if (webhookForm.subscriptions?.length > 0) {
        await api(`/api/webhooks/${saved.id}/subscriptions`, {
          method: 'POST',
          body: JSON.stringify({ subscriptions: webhookForm.subscriptions }),
        });
      }

      setShowWebhookForm(false);
      setEditingWebhookId(null);
      setWebhookForm({ name: '', url: '', secret: '', active: true, subscriptions: [] });
      await loadWebhooks();
      setMessage('Webhook saved.');
    } catch (err) {
      reportError('Unable to save webhook', err);
    }
  }, [api, editingWebhookId, webhookForm, loadWebhooks, reportError]);

  const deleteWebhook = useCallback(async (id) => {
    try {
      await api(`/api/webhooks/${id}`, { method: 'DELETE' });
      setWebhookEndpoints((prev) => prev.filter((ep) => ep.id !== id));
      setMessage('Webhook deleted.');
    } catch (err) {
      reportError('Unable to delete webhook', err);
    }
  }, [api, reportError]);

  const testWebhook = useCallback(async (id) => {
    try {
      await api(`/api/webhooks/${id}/test`, { method: 'POST' });
      setMessage('Test event queued. Check the event log for delivery status.');
      setTimeout(() => loadWebhooks(), 2000);
    } catch (err) {
      reportError('Unable to test webhook', err);
    }
  }, [api, loadWebhooks, reportError]);

  const triggerWebhook = useCallback(async (endpointId, callAttemptId) => {
    try {
      await api(`/api/webhooks/${endpointId}/trigger`, {
        method: 'POST',
        body: JSON.stringify({ callAttemptId }),
      });
      setMessage('Webhook triggered.');
    } catch (err) {
      reportError('Unable to trigger webhook', err);
    }
  }, [api, reportError]);

  const supportsAudioOutputSelection = useCallback(() => {
    return typeof remoteMediaRef.current?.setSinkId === 'function';
  }, []);

  const refreshAudioDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setMicrophones([]);
      setSpeakers([]);
      console.warn('[Dialer] enumerateDevices is not available');
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const nextMicrophones = devices.filter((device) => device.kind === 'audioinput');
    const nextSpeakers = devices.filter((device) => device.kind === 'audiooutput');

    setMicrophones(nextMicrophones);
    setSpeakers(nextSpeakers);

    if (selectedMicrophone && !nextMicrophones.some((device) => device.deviceId === selectedMicrophone)) {
      setSelectedMicrophone('');
    }

    if (selectedSpeaker && !nextSpeakers.some((device) => device.deviceId === selectedSpeaker)) {
      setSelectedSpeaker('');
    }
  }, [selectedMicrophone, selectedSpeaker]);

  const applyAudioOutput = useCallback(
    async (deviceId) => {
      if (!supportsAudioOutputSelection()) return;

      try {
        await remoteMediaRef.current.setSinkId(deviceId);
        setSelectedSpeaker(deviceId);
        saveDeviceId(audioOutputStorageKey, deviceId);
        console.info('[Dialer] Audio output selected', {
          deviceId: deviceId || 'system-default',
          sinkId: remoteMediaRef.current.sinkId || 'system-default',
        });
      } catch (audioError) {
        reportError('Unable to select audio output', audioError);
      }
    },
    [reportError, supportsAudioOutputSelection],
  );

  useEffect(() => {
    refreshAudioDevices().catch((deviceError) => {
      console.warn('[Dialer] Unable to refresh audio devices before permission', deviceError);
    });

    const handler = () => {
      refreshAudioDevices().catch((deviceError) => reportError('Unable to refresh audio devices', deviceError));
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, [refreshAudioDevices, reportError]);

  const getSelectedAudioConstraints = useCallback(() => {
    return selectedMicrophone ? { deviceId: { exact: selectedMicrophone } } : true;
  }, [selectedMicrophone]);

  const getMicrophoneStream = useCallback(() => {
    return navigator.mediaDevices.getUserMedia({ audio: getSelectedAudioConstraints() });
  }, [getSelectedAudioConstraints]);

  const setDiagnosticsIdle = useCallback((idleMessage = 'Idle') => {
    setDiagnostics({
      network: idleMessage,
      audio: idleMessage,
      codec: 'Unknown',
      ice: 'Unknown',
      details: '',
    });
  }, []);

  const updateDiagnostics = useCallback(async () => {
    const activeCall = activeCallRef.current;

    if (!activeCall) {
      setDiagnosticsIdle();
      return;
    }

    const pc = getPeerConnection(activeCall);

    if (!pc?.getStats) {
      setDiagnostics({
        network: 'Waiting',
        audio: 'Waiting for media',
        codec: 'Unknown',
        ice: 'Unknown',
        details: JSON.stringify(
          {
            call: summarizeCall(activeCall),
            localAudioTracks: summarizeAudioTracks(activeCall.localStream),
            remoteAudioTracks: summarizeAudioTracks(remoteMediaRef.current?.srcObject || activeCall.remoteStream),
          },
          null,
          2,
        ),
      });
      return;
    }

    try {
      const report = await pc.getStats();
      const stats = [...report.values()];
      const pair = getSelectedCandidatePair(stats);
      const { inbound, outbound, remoteInbound } = getAudioStats(stats);
      const packetsLost = inbound?.packetsLost ?? 0;
      const packetsReceived = inbound?.packetsReceived ?? 0;
      const totalInboundPackets = packetsLost + packetsReceived;
      const packetLossPercent = totalInboundPackets > 0 ? (packetsLost / totalInboundPackets) * 100 : 0;
      const jitterMs = Number.isFinite(inbound?.jitter) ? inbound.jitter * 1000 : NaN;
      const rttMs = Number.isFinite(pair?.currentRoundTripTime)
        ? pair.currentRoundTripTime * 1000
        : Number.isFinite(remoteInbound?.roundTripTime)
          ? remoteInbound.roundTripTime * 1000
          : NaN;
      const inboundCodec = getCodecLabel(report, inbound);
      const outboundCodec = getCodecLabel(report, outbound);
      const iceLabel = getIceLabel(report, pair);
      const localAudioTracks = summarizeAudioTracks(activeCall.localStream);
      const remoteAudioTracks = summarizeAudioTracks(remoteMediaRef.current?.srcObject || activeCall.remoteStream);
      const networkQuality = getNetworkQuality({ jitterMs, packetLossPercent, rttMs });
      const networkReason = networkQuality.reasons.length ? `; ${networkQuality.reasons.join(', ')}` : '';
      const remoteTrackSummary = remoteAudioTracks.length
        ? `${remoteAudioTracks.length} remote track${remoteAudioTracks.length === 1 ? '' : 's'}`
        : 'No remote track';

      setDiagnostics({
        network: `${networkQuality.label} (${formatPercent(packetLossPercent)} loss, ${formatMs(jitterMs)} jitter, ${formatMs(rttMs)} RTT${networkReason})`,
        audio: `${remoteTrackSummary}, sink ${remoteMediaRef.current?.sinkId || 'system-default'}`,
        codec: inboundCodec === outboundCodec ? inboundCodec : `in ${inboundCodec}, out ${outboundCodec}`,
        ice: iceLabel,
        details: JSON.stringify(
          {
            call: summarizeCall(activeCall),
            peerConnection: {
              connectionState: pc.connectionState,
              iceConnectionState: pc.iceConnectionState,
              iceGatheringState: pc.iceGatheringState,
              signalingState: pc.signalingState,
            },
            network: {
              quality: networkQuality.label,
              reasons: networkQuality.reasons,
              packetLoss: formatPercent(packetLossPercent),
              packetsLost,
              packetsReceived,
              jitter: formatMs(jitterMs),
              roundTripTime: formatMs(rttMs),
              bytesReceived: formatBytes(inbound?.bytesReceived),
              bytesSent: formatBytes(outbound?.bytesSent),
            },
            codecs: {
              inbound: inboundCodec,
              outbound: outboundCodec,
            },
            ice: {
              route: iceLabel,
              bytesSent: formatBytes(pair?.bytesSent),
              bytesReceived: formatBytes(pair?.bytesReceived),
            },
            audio: {
              outputDeviceId: remoteMediaRef.current?.sinkId || 'system-default',
              remoteElementPaused: remoteMediaRef.current?.paused,
              remoteElementMuted: remoteMediaRef.current?.muted,
              remoteElementVolume: remoteMediaRef.current?.volume,
              localAudioTracks,
              remoteAudioTracks,
            },
          },
          null,
          2,
        ),
      });
    } catch (diagnosticsError) {
      console.warn('[Dialer] Unable to collect call diagnostics', diagnosticsError);
      setDiagnostics((current) => ({
        ...current,
        network: 'Stats unavailable',
        details: JSON.stringify({ error: diagnosticsError.message }, null, 2),
      }));
    }
  }, [setDiagnosticsIdle]);

  const stopDiagnostics = useCallback(
    (reset = true) => {
      if (diagnosticsTimerRef.current) {
        window.clearInterval(diagnosticsTimerRef.current);
        diagnosticsTimerRef.current = null;
      }
      if (reset) setDiagnosticsIdle();
    },
    [setDiagnosticsIdle],
  );

  const startDiagnostics = useCallback(() => {
    stopDiagnostics(false);
    updateDiagnostics();
    diagnosticsTimerRef.current = window.setInterval(updateDiagnostics, 1000);
  }, [stopDiagnostics, updateDiagnostics]);

  const ensureRemoteAudioPlaying = useCallback(
    async (context) => {
      const remoteMedia = remoteMediaRef.current;
      if (!remoteMedia) return;

      remoteMedia.muted = false;
      remoteMedia.volume = 1;

      try {
        await remoteMedia.play();
        console.info('[Dialer] Remote audio playback checked', {
          context,
          sinkId: remoteMedia.sinkId || 'system-default',
          paused: remoteMedia.paused,
          muted: remoteMedia.muted,
          volume: remoteMedia.volume,
          readyState: remoteMedia.readyState,
          trackCount: remoteMedia.srcObject?.getAudioTracks?.().length || 0,
        });
      } catch (playError) {
        reportError('Unable to play remote call audio', playError);
      }
    },
    [reportError],
  );

  const patchCurrentCallAttempt = useCallback(
    async (data) => {
      if (!callAttemptRef.current?.id) return;

      try {
        await api(`/api/call-attempts/${callAttemptRef.current.id}`, {
          method: 'PATCH',
          body: JSON.stringify(data),
        });
      } catch (patchError) {
        console.warn('[Dialer] Unable to update call attempt', patchError);
      }
    },
    [api],
  );

  const connectTelnyx = useCallback(async () => {
    if (isReadyRef.current) return clientRef.current;
    if (isConnectingRef.current && connectPromiseRef.current) return connectPromiseRef.current;

    try {
      clearError();
      isConnectingRef.current = true;
      setMessage('Requesting microphone access...');
      const permissionStream = await getMicrophoneStream();
      permissionStream.getTracks().forEach((track) => track.stop());
      await refreshAudioDevices();
      await applyAudioOutput(selectedSpeaker);

      setConnectionStatus('Connecting');
      setMessage('Loading Telnyx credentials...');
      const credentials = await api('/api/telnyx-credentials');
      const clientOptions = credentials.login_token
        ? { login_token: credentials.login_token }
        : { login: credentials.login, password: credentials.password };

      connectPromiseRef.current = new Promise((resolve, reject) => {
        connectResolveRef.current = resolve;
        connectRejectRef.current = reject;
      });

      const telnyxClient = new TelnyxRTC(clientOptions);
      clientRef.current = telnyxClient;
      telnyxClient.remoteElement = 'remoteMedia';

      telnyxClient
        .on('telnyx.ready', () => {
          isReadyRef.current = true;
          isConnectingRef.current = false;
          setConnectionStatus('Ready');
          setMessage('Connected. Dialing...');
          clearError();
          connectResolveRef.current?.(telnyxClient);
          connectPromiseRef.current = null;
          connectResolveRef.current = null;
          connectRejectRef.current = null;
        })
        .on('telnyx.error', (telnyxError) => {
          isConnectingRef.current = false;
          setConnectionStatus('Error');
          reportError('Telnyx connection error', telnyxError);
          connectRejectRef.current?.(telnyxError);
          connectPromiseRef.current = null;
          connectResolveRef.current = null;
          connectRejectRef.current = null;
        })
        .on('telnyx.warning', (warning) => {
          console.warn('[Dialer] Telnyx warning', warning);
        })
        .on('telnyx.socket.error', (socketError) => {
          reportError('Telnyx socket error', socketError);
        })
        .on('telnyx.socket.close', () => {
          console.info('[Dialer] Telnyx socket closed');
          isReadyRef.current = false;
          isConnectingRef.current = false;
          connectPromiseRef.current = null;
          connectResolveRef.current = null;
          connectRejectRef.current = null;
          setConnectionStatus('Disconnected');
        })
        .on('telnyx.rtc.mediaError', (mediaError) => reportError('Telnyx media error', mediaError))
        .on('telnyx.rtc.peerConnectionFailureError', (peerError) =>
          reportError('Telnyx peer connection error', peerError),
        )
        .on('telnyx.rtc.peerConnectionSignalingStateClosed', (signalingError) =>
          reportError('Telnyx signaling state closed', signalingError),
        )
        .on('telnyx.notification', (notification) => {
          if (notification.type !== 'callUpdate') return;

          activeCallRef.current = notification.call;
          const state = getCallState(activeCallRef.current);
          console.info('[Dialer] Call update', summarizeCall(activeCallRef.current), notification);
          setCallStatus(getCallStateLabel(activeCallRef.current));

          if (playableCallStates.has(state)) {
            ensureRemoteAudioPlaying(getCallStateLabel(activeCallRef.current));
          }

          if (state === 'active' || state === 7) {
            patchCurrentCallAttempt({ status: 'active', answeredAt: new Date().toISOString() });
          }

          if (terminalCallStates.has(state)) {
            const finalCall = activeCallRef.current;
            const summary = summarizeCall(finalCall);

            if (hasCallFailure(finalCall)) {
              const failureSummary = formatCallFailure(finalCall);
              console.error('[Dialer] Call failure', summary, notification);
              setMessage(failureSummary);
              setError({ summary: failureSummary, details: summary });
              patchCurrentCallAttempt({
                status: 'failed',
                endedAt: new Date().toISOString(),
                sipCode: finalCall.sipCode || undefined,
                sipReason: finalCall.sipReason || undefined,
                failureReason: failureSummary,
                telnyxSessionId: finalCall.telnyxIDs?.telnyxSessionId,
                telnyxLegId: finalCall.telnyxIDs?.telnyxLegId,
                telnyxCallControlId: finalCall.telnyxIDs?.telnyxCallControlId,
              });
            } else {
              console.info('[Dialer] Call ended normally', summary, notification);
              setMessage('Call ended normally.');
              patchCurrentCallAttempt({
                status: 'completed',
                endedAt: new Date().toISOString(),
                telnyxSessionId: finalCall.telnyxIDs?.telnyxSessionId,
                telnyxLegId: finalCall.telnyxIDs?.telnyxLegId,
                telnyxCallControlId: finalCall.telnyxIDs?.telnyxCallControlId,
              });
            }

            stopDiagnostics(false);
            activeCallRef.current = null;
            setCallStatus('Idle');
            loadData().catch((loadError) => console.warn('[Dialer] Unable to refresh data after call', loadError));
          }
        });

      telnyxClient.__callerNumber = credentials.callerNumber;
      console.info('[Dialer] Connecting Telnyx client', {
        authMode: credentials.login_token ? 'login_token' : 'username_password',
        hasCallerNumber: Boolean(credentials.callerNumber),
      });
      telnyxClient.connect();
      return connectPromiseRef.current;
    } catch (connectError) {
      isConnectingRef.current = false;
      connectRejectRef.current?.(connectError);
      connectPromiseRef.current = null;
      connectResolveRef.current = null;
      connectRejectRef.current = null;
      setConnectionStatus('Disconnected');
      reportError('Unable to connect Telnyx client', connectError);
      throw connectError;
    }
  }, [
    api,
    applyAudioOutput,
    clearError,
    ensureRemoteAudioPlaying,
    getMicrophoneStream,
    loadData,
    patchCurrentCallAttempt,
    refreshAudioDevices,
    reportError,
    selectedSpeaker,
    stopDiagnostics,
  ]);

  const placeCall = useCallback(
    async (event) => {
      event?.preventDefault();
      const destinationNumber = phoneNumber.trim();

      if (!e164Pattern.test(destinationNumber)) {
        setMessage('Enter a phone number in E.164 format, for example +15551234567.');
        return;
      }

      try {
        clearError();
        setMessage('Checking DNC/suppression list...');
        const callAttemptBody = await api('/api/call-attempts', {
          method: 'POST',
          body: JSON.stringify({
            phoneNumber: destinationNumber,
            contactId: dialContact?.id,
            campaignId: selectedCampaignId || undefined,
            campaignMemberId: currentQueueMember?.id,
            recordingRequested,
            recordingConsentChecked,
          }),
        });

        callAttemptRef.current = callAttemptBody.callAttempt;

        if (!isReadyRef.current) {
          setMessage('Connecting before dialing...');
          await connectTelnyx();
        }

        const callOptions = {
          destinationNumber,
          callerNumber: clientRef.current.__callerNumber || undefined,
          audio: getSelectedAudioConstraints(),
          micId: selectedMicrophone || undefined,
        };

        console.info('[Dialer] Placing call', callOptions);
        activeCallRef.current = clientRef.current.newCall(callOptions);
        console.info('[Dialer] Call created', summarizeCall(activeCallRef.current));
        await patchCurrentCallAttempt({ status: 'dialing' });
        startDiagnostics();
        setCallStatus('Calling');
        setMessage(`Calling ${destinationNumber}...`);
      } catch (callError) {
        if (callError.status === 409) {
          setError({
            summary: 'Call blocked by DNC/suppression',
            details: callError.body,
          });
          setMessage(callError.body?.error || 'Call blocked.');
        } else {
          activeCallRef.current = null;
          setCallStatus('Idle');
          reportError('Unable to place call', callError);
        }
      }
    },
    [
      api,
      clearError,
      connectTelnyx,
      currentQueueMember?.id,
      dialContact?.id,
      getSelectedAudioConstraints,
      patchCurrentCallAttempt,
      phoneNumber,
      recordingConsentChecked,
      recordingRequested,
      reportError,
      selectedCampaignId,
      selectedMicrophone,
      startDiagnostics,
    ],
  );

  const hangup = useCallback(() => {
    if (!activeCallRef.current) return;

    activeCallRef.current.hangup().catch((hangupError) => {
      reportError('Unable to hang up call cleanly', hangupError);
    });
    activeCallRef.current = null;
    setCallStatus('Idle');
    setMessage('Call ended.');
    stopDiagnostics(false);
  }, [reportError, stopDiagnostics]);

  const testSpeaker = useCallback(async () => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      reportError('Unable to test speaker', new Error('Web Audio is not supported in this browser.'));
      return;
    }

    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const destination = context.createMediaStreamDestination();
    const testAudio = new Audio();

    oscillator.type = 'sine';
    oscillator.frequency.value = 660;
    gain.gain.value = 0.08;
    oscillator.connect(gain).connect(destination);
    testAudio.srcObject = destination.stream;

    try {
      if (supportsAudioOutputSelection()) await testAudio.setSinkId(selectedSpeaker);
      await context.resume();
      await testAudio.play();
      oscillator.start();
      setMessage('Playing speaker test tone...');
      setTimeout(() => {
        oscillator.stop();
        testAudio.pause();
        destination.stream.getTracks().forEach((track) => track.stop());
        context.close();
        setMessage('Speaker test finished.');
      }, 900);
    } catch (speakerError) {
      oscillator.disconnect();
      gain.disconnect();
      destination.stream.getTracks().forEach((track) => track.stop());
      context.close();
      reportError('Unable to test speaker', speakerError);
    }
  }, [reportError, selectedSpeaker, supportsAudioOutputSelection]);

  const stopMicTest = useCallback(() => {
    if (!micTestRef.current) return;

    cancelAnimationFrame(micTestRef.current.animationFrame);
    micTestRef.current.stream.getTracks().forEach((track) => track.stop());
    micTestRef.current.context.close();
    micTestRef.current = null;
    setMicLevel(0);
    setMicTestActive(false);
    setMessage('Microphone test stopped.');
  }, []);

  const startMicTest = useCallback(async () => {
    if (micTestRef.current) {
      stopMicTest();
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      reportError('Unable to test microphone', new Error('Web Audio is not supported in this browser.'));
      return;
    }

    try {
      const stream = await getMicrophoneStream();
      await refreshAudioDevices();
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      const samples = new Uint8Array(analyser.fftSize);

      source.connect(analyser);
      await context.resume();

      micTestRef.current = { analyser, animationFrame: 0, context, stream };
      setMicTestActive(true);
      setMessage('Testing microphone...');

      const updateMeter = () => {
        analyser.getByteTimeDomainData(samples);
        const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample - 128)), 0);
        const percent = Math.min(100, Math.round((peak / 64) * 100));
        setMicLevel(percent);
        micTestRef.current.animationFrame = requestAnimationFrame(updateMeter);
      };

      updateMeter();
    } catch (micError) {
      reportError('Unable to test microphone', micError);
    }
  }, [getMicrophoneStream, refreshAudioDevices, reportError, stopMicTest]);

  const createCampaign = useCallback(
    async (event) => {
      event.preventDefault();
      await api('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify(campaignForm),
      });
      setCampaignForm({ name: '', description: '', recordingDefault: 'off' });
      await loadData();
    },
    [api, campaignForm, loadData],
  );

  const createContact = useCallback(
    async (event) => {
      event.preventDefault();
      const phoneNumbers = contactForm.phoneNumbers
        .split(',')
        .map((number) => number.trim())
        .filter(Boolean);

      await api('/api/contacts', {
        method: 'POST',
        body: JSON.stringify({
          ...contactForm,
          phoneNumbers,
          campaignId: selectedCampaignId || undefined,
        }),
      });
      setContactForm({
        businessName: '',
        contactName: '',
        phoneNumbers: '',
        email: '',
        website: '',
        notes: '',
      });
      await loadData();
    },
    [api, contactForm, loadData, selectedCampaignId],
  );

  const addSuppression = useCallback(
    async (event) => {
      event.preventDefault();
      await api('/api/suppressions', {
        method: 'POST',
        body: JSON.stringify({
          phoneNumber: dncForm.phoneNumber,
          reason: dncForm.reason,
          type: 'do_not_call',
          scope: 'number',
        }),
      });
      setDncForm({ phoneNumber: '', reason: '' });
      await loadData();
    },
    [api, dncForm, loadData],
  );

  const importCsv = useCallback(
    async (event) => {
      const file = event.target.files?.[0];
      if (!file || !selectedCampaignId) return;

      setImporting(true);
      setImportResult(null);

      try {
        const parsed = await new Promise((resolve, reject) => {
          Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            complete: (result) => resolve(result),
            error: (err) => reject(err),
          });
        });

        const contacts = parsed.data.map((row) => {
          const address = row.address || '';
          let city = row.city || '';
          let state = row.state || '';
          if (!city && address) {
            const parts = address.split(',');
            if (parts.length >= 3) {
              const cityState = parts[parts.length - 2].trim();
              const stateZip = parts[parts.length - 1].trim();
              city = cityState;
              state = stateZip.split(/\s+/)[0] || state;
            }
          }

          const notes = [row.rating ? `Rating: ${row.rating}` : '', row.reviews ? `Reviews: ${row.reviews}` : '', row.place_id ? `Place ID: ${row.place_id}` : ''].filter(Boolean).join('\n');

          return {
            businessName: row.name || row.businessName || '',
            phoneNumbers: [row.phone, row.phone2, row.phone_2].filter(Boolean),
            website: row.website || null,
            address: address || null,
            city: city || null,
            state: state || null,
            notes: notes || null,
          };
        });

        const result = await api(`/api/campaigns/${selectedCampaignId}/import`, {
          method: 'POST',
          body: JSON.stringify({ contacts }),
        });

        setImportResult(result);
        await loadData();
        await loadCampaignMembers();
      } catch (importError) {
        setImportResult({ error: importError.body?.error || importError.message || 'Import failed.' });
      } finally {
        setImporting(false);
        event.target.value = '';
      }
    },
    [api, loadData, loadCampaignMembers, selectedCampaignId],
  );

  const loadNextContact = useCallback(async () => {
    if (!selectedCampaignId) {
      setMessage('Select a campaign first.');
      return;
    }

    const body = await api(`/api/campaigns/${selectedCampaignId}/queue/next`);
    setCurrentQueueMember(body.member);

    const firstNumber = body.member?.contact?.phoneNumbers?.[0]?.normalizedNumber;
    if (firstNumber) setPhoneNumber(firstNumber);
    setRecordingRequested(body.member?.campaign?.recordingDefault === 'on');
    setMessage(body.member ? `Loaded ${body.member.contact.businessName}.` : 'No queued contacts in this campaign.');
  }, [api, selectedCampaignId]);

  useEffect(() => {
    return () => {
      stopDiagnostics();
      stopMicTest();
      activeCallRef.current?.hangup();
      clientRef.current?.disconnect();
    };
  }, [stopDiagnostics, stopMicTest]);

  const metrics = dashboard?.metrics || {};

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Phone size={22} />
          <div>
            <strong>Dialer</strong>
            <span>{me?.workspace?.name || 'Loading workspace'}</span>
          </div>
        </div>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={view === item.id ? 'active' : ''}
                type="button"
                onClick={() => { setView(item.id); setSelectedContactId(null); setContactDetail(null); }}
              >
                <Icon size={17} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <h1>{navItems.find((item) => item.id === view)?.label || 'Dialer'}</h1>
            <p>{me?.user?.email || 'Preparing workspace...'}</p>
          </div>
          <div className="topbar-actions">
            <button className="secondary" type="button" onClick={() => loadData()}>
              <RefreshCw size={15} />
              Refresh
            </button>
            {userMenu}
          </div>
        </header>

        {selectedContactId && contactDetail && (() => {
          const c = contactDetail.contact;
          return (
            <section className="single-column">
              <section className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <button className="secondary" type="button" onClick={() => { setSelectedContactId(null); setContactDetail(null); setEditingContact(false); }}>
                      <ChevronLeft size={16} />
                      Back
                    </button>
                  </div>
                  <button className="secondary" type="button" onClick={() => setEditingContact((prev) => !prev)}>
                    {editingContact ? 'Cancel' : 'Edit'}
                  </button>
                </div>

                {editingContact ? (
                  <form onSubmit={(e) => { e.preventDefault(); saveContactEdit(c.id, contactEditForm); }}>
                    <Field label="Business name">
                      <input value={contactEditForm.businessName} onChange={(e) => setContactEditForm((f) => ({ ...f, businessName: e.target.value }))} required />
                    </Field>
                    <Field label="Contact name">
                      <input value={contactEditForm.contactName} onChange={(e) => setContactEditForm((f) => ({ ...f, contactName: e.target.value }))} />
                    </Field>
                    <Field label="Email">
                      <input value={contactEditForm.email} onChange={(e) => setContactEditForm((f) => ({ ...f, email: e.target.value }))} />
                    </Field>
                    <Field label="Website">
                      <input value={contactEditForm.website} onChange={(e) => setContactEditForm((f) => ({ ...f, website: e.target.value }))} />
                    </Field>
                    <Field label="Address">
                      <input value={contactEditForm.address} onChange={(e) => setContactEditForm((f) => ({ ...f, address: e.target.value }))} />
                    </Field>
                    <div className="form-row" style={{ gap: 8 }}>
                      <Field label="City">
                        <input value={contactEditForm.city} onChange={(e) => setContactEditForm((f) => ({ ...f, city: e.target.value }))} />
                      </Field>
                      <Field label="State">
                        <input value={contactEditForm.state} onChange={(e) => setContactEditForm((f) => ({ ...f, state: e.target.value }))} />
                      </Field>
                    </div>
                    <Field label="Status">
                      <select value={contactEditForm.status} onChange={(e) => setContactEditForm((f) => ({ ...f, status: e.target.value }))}>
                        <option value="new">New</option>
                        <option value="queued">Queued</option>
                        <option value="called">Called</option>
                        <option value="callback">Callback</option>
                        <option value="qualified">Qualified</option>
                        <option value="bad_number">Bad number</option>
                        <option value="do_not_call">Do not call</option>
                        <option value="archived">Archived</option>
                      </select>
                    </Field>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontWeight: 700, color: '#4f5a6e' }}>
                      <input type="checkbox" checked={contactEditForm.doNotCall} onChange={(e) => setContactEditForm((f) => ({ ...f, doNotCall: e.target.checked }))} />
                      Do not call
                    </label>
                    <Field label="Notes">
                      <textarea value={contactEditForm.notes} onChange={(e) => setContactEditForm((f) => ({ ...f, notes: e.target.value }))} />
                    </Field>
                    <button type="submit">
                      <Plus size={16} />
                      Save changes
                    </button>
                  </form>
                ) : (
                  <>
                    <h2>{c.businessName || 'Contact'}</h2>
                    {c.contactName && <p style={{ color: '#4f5a6e', margin: '0 0 8px' }}>{c.contactName}</p>}
                    <div className="detail-meta">
                      <span>Status: {c.status}</span>
                      {c.doNotCall && <span className="dnc-badge">Do Not Call</span>}
                      {c.email && <span>{c.email}</span>}
                      {c.website && <span>{c.website}</span>}
                    </div>
                    <div className="detail-meta" style={{ marginTop: 8 }}>
                      {c.address && <span>{c.address}</span>}
                      {c.city && <span>{c.city}</span>}
                      {c.state && <span>{c.state}</span>}
                    </div>
                    <div className="detail-meta" style={{ marginTop: 8 }}>
                      {c.phoneNumbers?.map((n) => (
                        <span key={n.id}>{n.normalizedNumber}{n.isPrimary ? ' (primary)' : ''}</span>
                      ))}
                    </div>
                    {c.notes && (
                      <div style={{ marginTop: 12 }}>
                        <strong>Notes</strong>
                        <p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{c.notes}</p>
                      </div>
                    )}
                    {contactDetail.campaigns?.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <strong>Campaigns</strong>
                        <div className="detail-meta" style={{ marginTop: 4 }}>
                          {contactDetail.campaigns.map((camp) => (
                            <span key={camp.id}>{camp.name} ({camp.status})</span>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>

              {contactDetail.callAttempts?.length > 0 && (
                <section className="panel">
                  <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Call history</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Status</th>
                          <th>Outcome</th>
                          <th>Duration</th>
                          <th>Phone</th>
                          <th>Campaign</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contactDetail.callAttempts.map((call) => (
                          <tr key={call.id}>
                            <td>{new Date(call.startedAt).toLocaleString()}</td>
                            <td>{call.status}</td>
                            <td>{call.outcome || '-'}</td>
                            <td>{call.durationSeconds ? `${call.durationSeconds}s` : '-'}</td>
                            <td>{call.phoneNumber || '-'}</td>
                            <td>{call.campaignName || '-'}</td>
                            <td>{call.notes?.map((n) => n.body).join('; ') || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {contactDetail.callbacks?.length > 0 && (
                <section className="panel">
                  <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Callbacks</h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Due</th>
                          <th>Status</th>
                          <th>Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {contactDetail.callbacks.map((cb) => (
                          <tr key={cb.id}>
                            <td>{new Date(cb.dueAt).toLocaleString()}</td>
                            <td>{cb.status}</td>
                            <td>{cb.note || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </section>
          );
        })()}}

        {!selectedContactId && view === 'dashboard' && (
          <section className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0 }}>Dashboard</h2>
              <button className="secondary" type="button" onClick={() => downloadCsv('/api/reports/summary/export', 'summary-report.csv')}>
                <Download size={16} />
                Export report
              </button>
            </div>
            <div className="metric-grid kpi">
              <Metric label="Total calls" value={metrics.totalCalls || 0} />
              <Metric label="Answer rate" value={`${metrics.answerRate || 0}%`} />
              <Metric label="Contact rate" value={`${metrics.contactRate || 0}%`} />
              <Metric label="Avg duration" value={`${formatDuration(metrics.avgDuration)}`} />
              <Metric label="Calls today" value={metrics.callsToday || 0} />
              <Metric label="Answered today" value={metrics.answeredToday || 0} />
              <Metric label="Callbacks due" value={metrics.callbacksDue || 0} />
              <Metric label="DNC entries" value={metrics.dncCount || 0} />
            </div>
            <OutcomeFunnel breakdown={metrics.outcomeBreakdown || {}} />
            <TrendChart trend={metrics.trend || []} />
            <h2>Recent calls</h2>
            <DataTable
              rows={dashboard?.recentCalls || []}
              columns={[
                ['contactName', 'Contact'],
                ['number', 'Number'],
                ['status', 'Status'],
                ['outcome', 'Outcome'],
                ['durationSeconds', 'Duration'],
                ['campaignName', 'Campaign'],
              ]}
            />
          </section>
        )}

        {view === 'dialer' && (
          <section className="dialer-layout">
            <div className="panel dialer-card">
              <div className="status-panel" aria-live="polite">
                <div>
                  <span>Connection</span>
                  <strong>{connectionStatus}</strong>
                </div>
                <div>
                  <span>Call</span>
                  <strong>{callStatus}</strong>
                </div>
              </div>

              <form onSubmit={placeCall}>
                <div className="form-row">
                  <Field label="Campaign">
                    <select value={selectedCampaignId} onChange={(event) => setSelectedCampaignId(event.target.value)}>
                      <option value="">Manual dial</option>
                      {campaigns.map((campaign) => (
                        <option key={campaign.id} value={campaign.id}>
                          {campaign.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="secondary align-end" type="button" onClick={loadNextContact}>
                      Next
                    </button>
                    {currentQueueMember && (
                      <>
                        <button className="secondary" type="button" onClick={() => skipQueueMember(currentQueueMember.id)} style={{ background: '#6b5b00' }}>
                          Skip
                        </button>
                        <button className="secondary" type="button" onClick={() => callbackQueueMember(currentQueueMember.id, 1)} style={{ background: '#2d5a2d' }}>
                          Callback 1h
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {dialContact && (
                  <section className="contact-card">
                    <strong>{dialContact.businessName}</strong>
                    <span>{dialContact.contactName || 'No contact name'}</span>
                    <span>{dialContact.email || 'No email'}</span>
                    <span>{dialContact.website || 'No website'}</span>
                  </section>
                )}

                <Field label="Number to dial">
                  <input
                    value={phoneNumber}
                    onChange={(event) => setPhoneNumber(event.target.value)}
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    placeholder="+15551234567"
                    pattern="^\+[1-9]\d{1,14}$"
                    required
                  />
                </Field>

                {dialPhoneOptions.length > 1 && (
                  <div className="number-swatches">
                    {dialPhoneOptions.map((number) => (
                      <button
                        key={number.id}
                        className="chip"
                        type="button"
                        onClick={() => setPhoneNumber(number.normalizedNumber)}
                      >
                        {number.normalizedNumber}
                      </button>
                    ))}
                  </div>
                )}

                <div className="audio-devices">
                  <Field label="Microphone">
                    <select
                      value={selectedMicrophone}
                      onChange={(event) => {
                        setSelectedMicrophone(event.target.value);
                        saveDeviceId(microphoneStorageKey, event.target.value);
                        stopMicTest();
                        if (activeCallRef.current?.setAudioInDevice && event.target.value) {
                          activeCallRef.current.setAudioInDevice(event.target.value).catch((switchError) => {
                            reportError('Unable to switch microphone for active call', switchError);
                          });
                        }
                      }}
                    >
                      <option value="">System default</option>
                      {microphones.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {getDeviceLabel(device, index, 'Microphone')}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <div className="device-test">
                    <button className="secondary" type="button" onClick={startMicTest}>
                      {micTestActive ? 'Stop mic' : 'Test mic'}
                    </button>
                    <div className="mic-meter" aria-hidden="true">
                      <span style={{ width: `${micLevel}%` }} />
                    </div>
                  </div>

                  <Field label="Speaker">
                    <select
                      value={selectedSpeaker}
                      disabled={!supportsAudioOutputSelection()}
                      onChange={(event) => applyAudioOutput(event.target.value)}
                    >
                      <option value="">System default</option>
                      {speakers.map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {getDeviceLabel(device, index, 'Speaker')}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <button className="secondary" type="button" onClick={testSpeaker}>
                    Test speaker
                  </button>
                </div>

                <div className="recording-controls">
                  <label>
                    <input
                      type="checkbox"
                      checked={recordingRequested}
                      onChange={(event) => setRecordingRequested(event.target.checked)}
                    />
                    Record this call
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={recordingConsentChecked}
                      onChange={(event) => setRecordingConsentChecked(event.target.checked)}
                    />
                    Consent checked
                  </label>
                </div>

                <div className="actions">
                  <button type="submit" disabled={isConnectingRef.current || Boolean(activeCallRef.current)}>
                    Dial
                  </button>
                  <button type="button" id="hangupButton" onClick={hangup} disabled={!activeCallRef.current}>
                    Hang up
                  </button>
                </div>

                {callAttemptRef.current && !activeCallRef.current && callStatus === 'Idle' && (
                  <section className="outcome-panel">
                    <h3>Call outcome</h3>
                    <Field label="Outcome">
                      <select
                        value={callOutcome.outcome}
                        onChange={(event) => setCallOutcome((prev) => ({ ...prev, outcome: event.target.value }))}
                      >
                        <option value="">Select outcome</option>
                        <option value="answered">Answered</option>
                        <option value="no_answer">No answer</option>
                        <option value="left_voicemail">Left voicemail</option>
                        <option value="interested">Interested</option>
                        <option value="not_interested">Not interested</option>
                        <option value="callback_requested">Callback requested</option>
                        <option value="gatekeeper">Gatekeeper</option>
                        <option value="needs_follow_up">Needs follow up</option>
                        <option value="wrong_number">Wrong number</option>
                        <option value="bad_number">Bad number</option>
                        <option value="do_not_call">Do not call</option>
                      </select>
                    </Field>
                    <Field label="Notes">
                      <textarea
                        value={callOutcome.notes}
                        onChange={(event) => setCallOutcome((prev) => ({ ...prev, notes: event.target.value }))}
                        placeholder="Call notes..."
                      />
                    </Field>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, fontWeight: 700, color: '#4f5a6e' }}>
                      <input
                        type="checkbox"
                        checked={callOutcome.doNotCall}
                        onChange={(event) => setCallOutcome((prev) => ({ ...prev, doNotCall: event.target.checked }))}
                      />
                      Do not call again
                    </label>
                    {callOutcome.outcome === 'callback_requested' && (
                      <>
                        <Field label="Callback date">
                          <input
                            type="datetime-local"
                            value={callOutcome.callbackDueAt}
                            onChange={(event) => setCallOutcome((prev) => ({ ...prev, callbackDueAt: event.target.value }))}
                          />
                        </Field>
                        <Field label="Callback note">
                          <input
                            value={callOutcome.callbackNote}
                            onChange={(event) => setCallOutcome((prev) => ({ ...prev, callbackNote: event.target.value }))}
                            placeholder="Reason for callback"
                          />
                        </Field>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={!callOutcome.outcome}
                      onClick={() => submitCallOutcome(callAttemptRef.current?.id, dialContact?.id)}
                    >
                      Save outcome
                    </button>
                    {webhookEndpoints.length > 0 && callAttemptRef.current && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            const epId = webhookEndpoints[0].id;
                            triggerWebhook(epId, callAttemptRef.current.id);
                          }}
                          style={{ background: '#4f46e5', color: '#fff' }}
                        >
                          <Send size={14} />
                          Send to n8n
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </form>

              <p className="message" role="status">
                {message}
              </p>
              {error && (
                <section className="error-panel" role="alert">
                  <strong>{error.summary}</strong>
                  <pre>{JSON.stringify(error.details, null, 2)}</pre>
                </section>
              )}
              <audio id="remoteMedia" ref={remoteMediaRef} autoPlay playsInline />
            </div>

            <DiagnosticsPanel diagnostics={diagnostics} />
          </section>
        )}

        {!selectedContactId && view === 'campaigns' && !selectedCampaignId && (
          <section className="single-column">
            <section className="panel">
              <button
                className="secondary collapsible-toggle"
                type="button"
                onClick={() => setShowCreateCampaign((prev) => !prev)}
              >
                {showCreateCampaign ? 'Hide' : 'Create campaign'}
              </button>
              {showCreateCampaign && (
                <form onSubmit={createCampaign}>
                  <Field label="Name">
                    <input
                      value={campaignForm.name}
                      onChange={(event) => setCampaignForm((current) => ({ ...current, name: event.target.value }))}
                      required
                    />
                  </Field>
                  <Field label="Description">
                    <textarea
                      value={campaignForm.description}
                      onChange={(event) =>
                        setCampaignForm((current) => ({ ...current, description: event.target.value }))
                      }
                    />
                  </Field>
                  <Field label="Recording default">
                    <select
                      value={campaignForm.recordingDefault}
                      onChange={(event) =>
                        setCampaignForm((current) => ({ ...current, recordingDefault: event.target.value }))
                      }
                    >
                      <option value="off">Off</option>
                      <option value="on">On</option>
                      <option value="ask_each_call">Ask each call</option>
                    </select>
                  </Field>
                  <button type="submit">
                    <Plus size={16} />
                    Add campaign
                  </button>
                </form>
              )}
            </section>

            <section className="panel">
              <h2>Import CSV</h2>
              <p style={{ color: '#657086', fontSize: 14, margin: '0 0 12px' }}>
                Select a campaign, then upload a CSV file with columns: name, phone, address, website, rating, reviews.
              </p>
              <Field label="Target campaign">
                <select value={selectedCampaignId} onChange={(event) => setSelectedCampaignId(event.target.value)}>
                  <option value="">Select a campaign</option>
                  {campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className={`import-upload${!selectedCampaignId ? ' disabled' : ''}`}>
                <Upload size={16} />
                {importing ? 'Importing...' : 'Choose CSV file'}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={importCsv}
                  disabled={!selectedCampaignId || importing}
                  style={{ display: 'none' }}
                />
              </label>
              {importResult && !importResult.error && (
                <p style={{ color: '#137333', fontSize: 14, margin: '8px 0 0' }}>
                  Imported {importResult.committedRows || importResult.importBatch?.committedRows} of{' '}
                  {importResult.totalRows || importResult.importBatch?.totalRows} contacts.
                  {importResult.invalidRows || importResult.importBatch?.invalidRows
                    ? ` ${importResult.invalidRows || importResult.importBatch?.invalidRows} invalid.`
                    : ''}
                  {importResult.duplicateRows || importResult.importBatch?.duplicateRows
                    ? ` ${importResult.duplicateRows || importResult.importBatch?.duplicateRows} merged into existing.`
                    : ''}
                </p>
              )}
              {importResult?.error && (
                <p style={{ color: '#b42318', fontSize: 14, margin: '8px 0 0' }}>
                  {importResult.error}
                </p>
              )}
            </section>

            <section className="panel">
              <h2>Campaigns</h2>
              {campaigns.length === 0 ? (
                <p className="empty">No campaigns yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Status</th>
                        <th>Members</th>
                        <th>Calls</th>
                      </tr>
                    </thead>
                    <tbody>
                      {campaigns.map((campaign) => (
                        <tr
                          key={campaign.id}
                          className="clickable-row"
                          onClick={() => setSelectedCampaignId(campaign.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>{campaign.name || '-'}</td>
                          <td>{campaign.status || '-'}</td>
                          <td>{campaign.members || 0}</td>
                          <td>{campaign.calls || 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </section>
        )}

        {!selectedContactId && view === 'campaigns' && selectedCampaignId && (() => {
          const campaign = campaigns.find((c) => c.id === selectedCampaignId);
          return (
            <section className="single-column">
              <section className="panel">
                <button className="secondary" type="button" onClick={() => setSelectedCampaignId('')}>
                  <ChevronLeft size={16} />
                  All campaigns
                </button>
                <h2>{campaign?.name || 'Campaign'}</h2>
                {campaign?.description && <p style={{ color: '#657086', fontSize: 14, margin: '0 0 4px' }}>{campaign.description}</p>}
                <div className="detail-meta">
                  <span>Status: {campaign?.status || '-'}</span>
                  <span>Recording: {campaign?.recordingDefault || '-'}</span>
                  <span>Members: {campaign?.members || 0}</span>
                  <span>Calls: {campaign?.calls || 0}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  {campaign?.status === 'active' && (
                    <>
                      <button className="secondary" type="button" onClick={() => updateCampaignStatus(campaign.id, 'paused')} style={{ background: '#8a6d00' }}>
                        Pause campaign
                      </button>
                      <button className="secondary" type="button" onClick={() => updateCampaignStatus(campaign.id, 'archived')} style={{ background: '#8a2020' }}>
                        Archive
                      </button>
                    </>
                  )}
                  {campaign?.status === 'paused' && (
                    <>
                      <button className="secondary" type="button" onClick={() => updateCampaignStatus(campaign.id, 'active')} style={{ background: '#2d5a2d' }}>
                        Resume
                      </button>
                      <button className="secondary" type="button" onClick={() => updateCampaignStatus(campaign.id, 'archived')} style={{ background: '#8a2020' }}>
                        Archive
                      </button>
                    </>
                  )}
                  {campaign?.status === 'archived' && (
                    <button className="secondary" type="button" onClick={() => updateCampaignStatus(campaign.id, 'active')} style={{ background: '#2d5a2d' }}>
                      Reactivate
                    </button>
                  )}
                </div>
              </section>

              {campaignReport && (
                <section className="panel">
                  <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Campaign stats</h3>
                  <div className="metric-grid kpi">
                    <Metric label="Total calls" value={campaignReport.stats.totalCalls || 0} />
                    <Metric label="Answer rate" value={`${campaignReport.stats.answerRate || 0}%`} />
                    <Metric label="Contact rate" value={`${campaignReport.stats.contactRate || 0}%`} />
                    <Metric label="Avg duration" value={formatDuration(campaignReport.stats.avgDuration)} />
                    <Metric label="DNC blocked" value={campaignReport.stats.dncBlocked || 0} />
                  </div>
                  {Object.keys(campaignReport.stats.outcomeBreakdown || {}).length > 0 && (
                    <OutcomeFunnel breakdown={campaignReport.stats.outcomeBreakdown} />
                  )}
                  <div className="detail-meta" style={{ marginTop: 8 }}>
                    <span>Queued: {campaignReport.campaign.memberStatusCounts.queued || 0}</span>
                    <span>Called: {campaignReport.campaign.memberStatusCounts.called || 0}</span>
                    <span>Callback: {campaignReport.campaign.memberStatusCounts.callback || 0}</span>
                    <span>Completed: {campaignReport.campaign.memberStatusCounts.completed || 0}</span>
                    <span>Skipped: {campaignReport.campaign.memberStatusCounts.skipped || 0}</span>
                  </div>
                </section>
              )}

              <section className="panel">
                <h3 style={{ margin: '0 0 14px', fontSize: 16 }}>Contacts</h3>
                {campaignMembers.length === 0 ? (
                  <p className="empty">No contacts in this campaign yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Business</th>
                          <th>Contact</th>
                          <th>Phone</th>
                          <th>Queue status</th>
                          <th>Attempts</th>
                          <th>Last called</th>
                          <th>Last outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {campaignMembers.map((member) => (
                          <tr key={member.id} className="clickable-row" onClick={() => setSelectedContactId(member.contact.id)} style={{ cursor: 'pointer' }}>
                            <td>{member.contact.businessName || '-'}</td>
                            <td>{member.contact.contactName || '-'}</td>
                            <td>{member.contact.phoneNumbers?.[0]?.normalizedNumber || '-'}</td>
                            <td>{member.status}</td>
                            <td>{member.attemptCount}</td>
                            <td>{member.lastCall?.startedAt
                              ? new Date(member.lastCall.startedAt).toLocaleDateString()
                              : '-'}</td>
                            <td>{member.lastCall?.outcome || member.lastCall?.status || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </section>
          );
        })()}

        {!selectedContactId && view === 'contacts' && (
          <section className="single-column">
            <section className="panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Contacts</h2>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="secondary" type="button" onClick={() => downloadCsv('/api/contacts/export', 'contacts.csv')}>
                    <Download size={16} />
                    Export CSV
                  </button>
                  <button className="secondary" type="button" onClick={findDuplicates} disabled={!!duplicateGroups}>
                    <Merge size={16} />
                    Find duplicates
                  </button>
                </div>
              </div>
              <Field label="Search">
                <input
                  value={contactSearch}
                  onChange={(event) => setContactSearch(event.target.value)}
                  placeholder="Search by name or email..."
                />
              </Field>
              {contacts.length === 0 ? (
                <p className="empty">No contacts yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Business</th>
                        <th>Contact</th>
                        <th>Phone</th>
                        <th>Status</th>
                        <th>DNC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts
                        .filter((c) => {
                          if (!contactSearch) return true;
                          const q = contactSearch.toLowerCase();
                          return (
                            (c.businessName || '').toLowerCase().includes(q) ||
                            (c.contactName || '').toLowerCase().includes(q) ||
                            (c.email || '').toLowerCase().includes(q) ||
                            c.phoneNumbers?.some((n) => n.normalizedNumber.includes(q))
                          );
                        })
                        .map((contact) => (
                          <tr
                            key={contact.id}
                            className="clickable-row"
                            onClick={() => setSelectedContactId(contact.id)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td>{contact.businessName || '-'}</td>
                            <td>{contact.contactName || '-'}</td>
                            <td>{contact.phoneNumbers?.map((n) => n.normalizedNumber).join(', ') || '-'}</td>
                            <td>{contact.status}</td>
                            <td>{contact.doNotCall ? 'Yes' : ''}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {duplicateGroups && (
              <section className="panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ margin: 0 }}>Duplicates</h2>
                  <button className="secondary" type="button" onClick={() => setDuplicateGroups(null)}>
                    Close
                  </button>
                </div>
                {(duplicateGroups.phoneDuplicates?.length || 0) === 0 && (duplicateGroups.nameDuplicates?.length || 0) === 0 ? (
                  <p className="empty">No duplicates found.</p>
                ) : (
                  <>
                    {duplicateGroups.phoneDuplicates?.length > 0 && (
                      <>
                        <h3 style={{ margin: '14px 0 8px', fontSize: 15 }}>Matching phone numbers</h3>
                        {duplicateGroups.phoneDuplicates.map((group, gi) => (
                          <div key={`phone-${gi}`} className="duplicate-group">
                            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#657086' }}>
                              Shared number: {group.phone}
                            </p>
                            {group.contacts.map((contact) => (
                              <div key={contact.id} className="duplicate-row">
                                <span>{contact.businessName}</span>
                                <span>{contact.contactName || '-'}</span>
                                <span>{contact.phoneNumbers?.map((n) => n.normalizedNumber).join(', ')}</span>
                                <span>{contact.status}</span>
                                <button className="secondary" type="button" style={{ fontSize: 13, minHeight: 28 }} onClick={() => mergeContacts(contact.id, group.contacts.filter((c) => c.id !== contact.id).map((c) => c.id))} disabled={merging}>
                                  Keep this one
                                </button>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    )}
                    {duplicateGroups.nameDuplicates?.length > 0 && (
                      <>
                        <h3 style={{ margin: '14px 0 8px', fontSize: 15 }}>Matching business names</h3>
                        {duplicateGroups.nameDuplicates.map((group, gi) => (
                          <div key={`name-${gi}`} className="duplicate-group">
                            <p style={{ margin: '0 0 8px', fontSize: 13, color: '#657086' }}>
                              Shared name: {group.name}
                            </p>
                            {group.contacts.map((contact) => (
                              <div key={contact.id} className="duplicate-row">
                                <span>{contact.businessName}</span>
                                <span>{contact.contactName || '-'}</span>
                                <span>{contact.phoneNumbers?.map((n) => n.normalizedNumber).join(', ') || '-'}</span>
                                <span>{contact.status}</span>
                                <button className="secondary" type="button" style={{ fontSize: 13, minHeight: 28 }} onClick={() => mergeContacts(contact.id, group.contacts.filter((c) => c.id !== contact.id).map((c) => c.id))} disabled={merging}>
                                  Keep this one
                                </button>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </section>
            )}
          </section>
        )}

        {view === 'dnc' && (
          <section className="split-view">
            <form className="panel form-panel" onSubmit={addSuppression}>
              <h2>Add DNC number</h2>
              <Field label="Phone number">
                <input
                  value={dncForm.phoneNumber}
                  onChange={(event) => setDncForm((current) => ({ ...current, phoneNumber: event.target.value }))}
                  placeholder="+15551234567"
                  required
                />
              </Field>
              <Field label="Reason">
                <textarea
                  value={dncForm.reason}
                  onChange={(event) => setDncForm((current) => ({ ...current, reason: event.target.value }))}
                />
              </Field>
              <button type="submit">
                <Ban size={16} />
                Add to DNC
              </button>
            </form>
            <section className="panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>DNC / suppression</h2>
                <button className="secondary" type="button" onClick={() => downloadCsv('/api/suppressions/export', 'dnc-suppressions.csv')}>
                  <Download size={16} />
                  Export CSV
                </button>
              </div>
              <DataTable
                rows={suppressions.map((entry) => ({
                  ...entry,
                  number: entry.normalizedNumber || entry.phoneNumber?.normalizedNumber,
                  contact: entry.contact?.businessName,
                  addedBy: entry.addedBy?.email,
                }))}
                columns={[
                  ['number', 'Number'],
                  ['contact', 'Contact'],
                  ['type', 'Type'],
                  ['scope', 'Scope'],
                  ['reason', 'Reason'],
                  ['source', 'Source'],
                ]}
              />
            </section>
          </section>
        )}

        {view === 'history' && (
          <section className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0 }}>Call history</h2>
              <button className="secondary" type="button" onClick={() => downloadCsv('/api/call-attempts/export', 'call-history.csv')}>
                <Download size={16} />
                Export CSV
              </button>
            </div>
            <DataTable
              rows={callAttempts.map((call) => ({
                ...call,
                contact: call.contact?.businessName || call.contact?.contactName || 'Manual dial',
                number: call.phoneNumber?.normalizedNumber,
                campaign: call.campaign?.name,
                agent: call.agent?.email,
              }))}
              columns={[
                ['contact', 'Contact'],
                ['number', 'Number'],
                ['status', 'Status'],
                ['outcome', 'Outcome'],
                ['campaign', 'Campaign'],
                ['agent', 'Agent'],
              ]}
            />
          </section>
        )}

        {view === 'integrations' && (
          <section className="single-column">
            <section className="panel">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Webhook endpoints</h2>
                <button type="button" onClick={() => { setShowWebhookForm(true); setEditingWebhookId(null); setWebhookForm({ name: '', url: '', secret: '', active: true, subscriptions: [] }); }}>
                  <Plus size={16} />
                  Add endpoint
                </button>
              </div>

              {showWebhookForm && (
                <form style={{ marginTop: 16, padding: 16, border: '1px solid #d8dde6', borderRadius: 6 }} onSubmit={(e) => { e.preventDefault(); saveWebhook(); }}>
                  <h3 style={{ margin: '0 0 12px' }}>{editingWebhookId ? 'Edit endpoint' : 'New webhook endpoint'}</h3>
                  <Field label="Name">
                    <input value={webhookForm.name} onChange={(e) => setWebhookForm((f) => ({ ...f, name: e.target.value }))} placeholder="n8n — SalesFu sync" required />
                  </Field>
                  <Field label="URL">
                    <input value={webhookForm.url} onChange={(e) => setWebhookForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://n8n.example.com/webhook/call-complete" required />
                  </Field>
                  <Field label="Secret (optional, for HMAC signing)">
                    <input type="password" value={webhookForm.secret} onChange={(e) => setWebhookForm((f) => ({ ...f, secret: e.target.value }))} placeholder="Leave blank for no signing" />
                  </Field>
                  <Field label="Events">
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {EVENT_TYPES.map((t) => (
                        <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
                          <input
                            type="checkbox"
                            checked={webhookForm.subscriptions.includes(t)}
                            onChange={(e) => setWebhookForm((f) => ({
                              ...f,
                              subscriptions: e.target.checked
                                ? [...f.subscriptions, t]
                                : f.subscriptions.filter((s) => s !== t),
                            }))}
                          />
                          {t}
                        </label>
                      ))}
                    </div>
                    <span style={{ fontSize: 12, color: '#657086', display: 'block', marginTop: 4 }}>Leave all unchecked to receive all events.</span>
                  </Field>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button type="submit">Save</button>
                    <button type="button" className="secondary" onClick={() => { setShowWebhookForm(false); setEditingWebhookId(null); }}>Cancel</button>
                  </div>
                </form>
              )}

              {webhookEndpoints.length === 0 ? (
                <p className="empty">No webhook endpoints configured. Add one to send call events to n8n, Zapier, or any HTTP endpoint.</p>
              ) : (
                <div className="table-wrap" style={{ marginTop: 16 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>URL</th>
                        <th>Active</th>
                        <th>Events</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {webhookEndpoints.map((ep) => (
                        <tr key={ep.id}>
                          <td>{ep.name}</td>
                          <td style={{ fontSize: 13, maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ep.url}</td>
                          <td>{ep.active ? 'Yes' : 'No'}</td>
                          <td style={{ fontSize: 12 }}>
                            {ep.subscriptions?.length > 0 ? ep.subscriptions.join(', ') : 'All events'}
                          </td>
                          <td style={{ display: 'flex', gap: 4 }}>
                            <button className="secondary" type="button" onClick={() => testWebhook(ep.id)} style={{ fontSize: 12, padding: '4px 8px' }}>Test</button>
                            <button className="secondary" type="button" onClick={() => { setEditingWebhookId(ep.id); setWebhookForm({ name: ep.name, url: ep.url, secret: '', active: ep.active, subscriptions: ep.subscriptions || [] }); setShowWebhookForm(true); }} style={{ fontSize: 12, padding: '4px 8px' }}>Edit</button>
                            <button className="secondary" type="button" onClick={() => { if (confirm('Delete this endpoint?')) deleteWebhook(ep.id); }} style={{ fontSize: 12, padding: '4px 8px', color: '#b91c1c' }}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel">
              <h2 style={{ margin: '0 0 12px' }}>Event log</h2>
              {webhookEvents.length === 0 ? (
                <p className="empty">No webhook events yet.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Event</th>
                        <th>Endpoint</th>
                        <th>Status</th>
                        <th>Attempts</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {webhookEvents.map((ev) => (
                        <tr key={ev.id}>
                          <td style={{ fontSize: 12 }}>{ev.eventType}</td>
                          <td style={{ fontSize: 12 }}>{ev.endpoint?.name || '-'}</td>
                          <td>
                            <span style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 12,
                              background: ev.status === 'delivered' ? '#d1fae5' : ev.status === 'failed' ? '#fee2e2' : '#fef3c7',
                              color: ev.status === 'delivered' ? '#065f46' : ev.status === 'failed' ? '#991b1b' : '#92400e',
                            }}>
                              {ev.status}
                            </span>
                          </td>
                          <td>{ev.attempts}</td>
                          <td style={{ fontSize: 12 }}>{new Date(ev.createdAt).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </section>
        )}
      </main>
    </div>
  );
}

const OUTCOME_COLORS = {
  interested: '#16a34a',
  needs_follow_up: '#2563eb',
  callback_requested: '#d97706',
  answered: '#4f46e5',
  left_voicemail: '#6366f1',
  no_answer: '#9ca3af',
  not_interested: '#dc2626',
  gatekeeper: '#ea580c',
  do_not_call: '#991b1b',
  wrong_number: '#7c3aed',
  bad_number: '#7c3aed',
};

const EVENT_TYPES = [
  'call.completed',
  'call.answered',
  'call.outcome.interested',
  'call.outcome.callback_requested',
  'call.outcome.not_interested',
  'call.outcome.do_not_call',
  'contact.dnc_added',
  'callback.due',
];

const OUTCOME_LABELS = {
  interested: 'Interested',
  needs_follow_up: 'Needs follow-up',
  callback_requested: 'Callback requested',
  answered: 'Answered',
  left_voicemail: 'Left voicemail',
  no_answer: 'No answer',
  not_interested: 'Not interested',
  gatekeeper: 'Gatekeeper',
  do_not_call: 'Do not call',
  wrong_number: 'Wrong number',
  bad_number: 'Bad number',
};

function formatDuration(seconds) {
  if (!seconds) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function OutcomeFunnel({ breakdown }) {
  const entries = Object.entries(breakdown);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const sorted = entries.sort((a, b) => b[1] - a[1]);
  return (
    <div className="outcome-funnel">
      <h3>Outcomes</h3>
      {sorted.map(([outcome, count]) => (
        <div key={outcome} className="funnel-bar-row">
          <span className="funnel-bar-label">{OUTCOME_LABELS[outcome] || outcome}</span>
          <div className="funnel-bar-track">
            <div
              className="funnel-bar-fill"
              style={{ width: `${(count / max) * 100}%`, background: OUTCOME_COLORS[outcome] || '#4f46e5' }}
            />
          </div>
          <span className="funnel-bar-count">{count}</span>
        </div>
      ))}
    </div>
  );
}

function TrendChart({ trend }) {
  if (!trend || trend.length === 0) return null;
  const max = Math.max(...trend.map((d) => d.count), 1);
  return (
    <div className="trend-row">
      <h3>Last 7 days</h3>
      <div className="trend-bars">
        {trend.map((d) => (
          <div key={d.date} className="trend-bar-col">
            <div
              className="trend-bar"
              style={{ height: `${(d.count / max) * 100}%` }}
              title={`${d.count} calls`}
            />
            <span className="trend-bar-date">{d.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DiagnosticsPanel({ diagnostics }) {
  return (
    <section className="panel diagnostics-panel" aria-live="polite">
      <h2>Call diagnostics</h2>
      <div className="diagnostics-grid">
        <div>
          <span>Network</span>
          <strong>{diagnostics.network}</strong>
        </div>
        <div>
          <span>Audio</span>
          <strong>{diagnostics.audio}</strong>
        </div>
        <div>
          <span>Codec</span>
          <strong>{diagnostics.codec}</strong>
        </div>
        <div>
          <span>ICE route</span>
          <strong>{diagnostics.ice}</strong>
        </div>
      </div>
      <pre>{diagnostics.details}</pre>
    </section>
  );
}

function DataTable({ rows, columns }) {
  if (!rows.length) return <p className="empty">No records yet.</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map(([, label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map(([key]) => (
                <td key={key}>{row[key] || '-'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
