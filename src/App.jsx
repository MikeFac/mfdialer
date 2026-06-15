import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TelnyxRTC } from '@telnyx/webrtc';
import {
  BarChart3,
  Ban,
  BookUser,
  Headphones,
  History,
  ListChecks,
  Phone,
  Plus,
  RefreshCw,
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
  if (![jitterMs, packetLossPercent, rttMs].some(Number.isFinite)) return 'Waiting';
  if (packetLossPercent > 5 || jitterMs > 50 || rttMs > 300) return 'Poor';
  if (packetLossPercent > 2 || jitterMs > 30 || rttMs > 150) return 'Fair';
  return 'Good';
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

function App({ authHeader, userMenu }) {
  const [view, setView] = useState('dialer');
  const [me, setMe] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
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
  }, [api]);

  useEffect(() => {
    loadData().catch((loadError) => reportError('Unable to load app data', loadError));
  }, [loadData, reportError]);

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
      const remoteTrackSummary = remoteAudioTracks.length
        ? `${remoteAudioTracks.length} remote track${remoteAudioTracks.length === 1 ? '' : 's'}`
        : 'No remote track';

      setDiagnostics({
        network: `${networkQuality} (${formatPercent(packetLossPercent)} loss, ${formatMs(jitterMs)} jitter)`,
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
              quality: networkQuality,
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
                onClick={() => setView(item.id)}
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

        {view === 'dashboard' && (
          <section className="panel">
            <div className="metric-grid">
              <Metric label="Campaigns" value={metrics.campaigns || 0} />
              <Metric label="Contacts" value={metrics.contacts || 0} />
              <Metric label="Calls today" value={metrics.callsToday || 0} />
              <Metric label="Answered today" value={metrics.answeredToday || 0} />
              <Metric label="Callbacks due" value={metrics.callbacksDue || 0} />
              <Metric label="DNC entries" value={metrics.dncCount || 0} />
            </div>
            <h2>Recent calls</h2>
            <DataTable
              rows={dashboard?.recentCalls || []}
              columns={[
                ['contactName', 'Contact'],
                ['number', 'Number'],
                ['status', 'Status'],
                ['outcome', 'Outcome'],
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
                  <button className="secondary align-end" type="button" onClick={loadNextContact}>
                    Next contact
                  </button>
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

        {view === 'campaigns' && (
          <section className="split-view">
            <form className="panel form-panel" onSubmit={createCampaign}>
              <h2>Create campaign</h2>
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
            <section className="panel">
              <h2>Campaigns</h2>
              <DataTable
                rows={campaigns}
                columns={[
                  ['name', 'Name'],
                  ['status', 'Status'],
                  ['recordingDefault', 'Recording'],
                  ['members', 'Members'],
                  ['calls', 'Calls'],
                ]}
              />
            </section>
          </section>
        )}

        {view === 'contacts' && (
          <section className="split-view">
            <form className="panel form-panel" onSubmit={createContact}>
              <h2>Add contact</h2>
              <Field label="Business name">
                <input
                  value={contactForm.businessName}
                  onChange={(event) => setContactForm((current) => ({ ...current, businessName: event.target.value }))}
                  required
                />
              </Field>
              <Field label="Contact name">
                <input
                  value={contactForm.contactName}
                  onChange={(event) => setContactForm((current) => ({ ...current, contactName: event.target.value }))}
                />
              </Field>
              <Field label="Phone numbers">
                <input
                  value={contactForm.phoneNumbers}
                  onChange={(event) => setContactForm((current) => ({ ...current, phoneNumbers: event.target.value }))}
                  placeholder="+15551234567, +15557654321"
                />
              </Field>
              <Field label="Email">
                <input
                  value={contactForm.email}
                  onChange={(event) => setContactForm((current) => ({ ...current, email: event.target.value }))}
                />
              </Field>
              <Field label="Website">
                <input
                  value={contactForm.website}
                  onChange={(event) => setContactForm((current) => ({ ...current, website: event.target.value }))}
                />
              </Field>
              <Field label="Notes">
                <textarea
                  value={contactForm.notes}
                  onChange={(event) => setContactForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </Field>
              <button type="submit">
                <Plus size={16} />
                Add contact
              </button>
            </form>
            <section className="panel">
              <h2>Contacts</h2>
              <DataTable
                rows={contacts.map((contact) => ({
                  ...contact,
                  phone: contact.phoneNumbers?.map((number) => number.normalizedNumber).join(', '),
                }))}
                columns={[
                  ['businessName', 'Business'],
                  ['contactName', 'Contact'],
                  ['phone', 'Phone'],
                  ['status', 'Status'],
                  ['email', 'Email'],
                ]}
              />
            </section>
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
              <h2>DNC / suppression</h2>
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
            <h2>Call history</h2>
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
      </main>
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
