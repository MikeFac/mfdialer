import 'webrtc-adapter';
import { TelnyxRTC } from '@telnyx/webrtc';
import './styles.css';

const connectionStatus = document.querySelector('#connectionStatus');
const callStatus = document.querySelector('#callStatus');
const message = document.querySelector('#message');
const phoneNumber = document.querySelector('#phoneNumber');
const form = document.querySelector('#dialerForm');
const callButton = document.querySelector('#callButton');
const hangupButton = document.querySelector('#hangupButton');
const microphone = document.querySelector('#microphone');
const audioOutput = document.querySelector('#audioOutput');
const remoteMedia = document.querySelector('#remoteMedia');
const testMicButton = document.querySelector('#testMicButton');
const testSpeakerButton = document.querySelector('#testSpeakerButton');
const micLevelBar = document.querySelector('#micLevelBar');
const errorPanel = document.querySelector('#errorPanel');
const errorSummary = document.querySelector('#errorSummary');
const errorDetails = document.querySelector('#errorDetails');

let client;
let activeCall;
let isReady = false;
let isConnecting = false;
let micTest;
let connectPromise;
let connectResolve;
let connectReject;

const terminalCallStates = new Set(['done', 'hangup', 'destroy', 'purge', 9, 10, 11]);
const playableCallStates = new Set(['early', 'active', 6, 7]);
const audioOutputStorageKey = 'telnyx-dialer-audio-output';
const microphoneStorageKey = 'telnyx-dialer-microphone';
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

function setConnectionStatus(value) {
  connectionStatus.textContent = value;
}

function setCallStatus(value) {
  callStatus.textContent = value;
}

function setMessage(value) {
  message.textContent = value;
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
    // Ignore storage failures; the selected device still applies for this page load.
  }
}

function supportsAudioOutputSelection() {
  return typeof remoteMedia.setSinkId === 'function';
}

function getDeviceLabel(device, index, fallbackLabel) {
  if (device.label) return device.label;
  if (device.deviceId === 'default') return `Default ${fallbackLabel.toLowerCase()}`;
  if (device.deviceId === 'communications') return `Default communications ${fallbackLabel.toLowerCase()}`;
  return `${fallbackLabel} ${index + 1}`;
}

function populateDeviceSelect(select, devices, selectedDeviceId, defaultLabel, fallbackLabel) {
  select.replaceChildren(new Option(defaultLabel, ''));

  devices.forEach((device, index) => {
    select.add(new Option(getDeviceLabel(device, index, fallbackLabel), device.deviceId));
  });

  const hasSelectedDevice = devices.some((device) => device.deviceId === selectedDeviceId);
  select.value = hasSelectedDevice ? selectedDeviceId : '';
  select.disabled = false;
  select.title = '';
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    microphone.disabled = true;
    audioOutput.disabled = true;
    testMicButton.disabled = true;
    testSpeakerButton.disabled = true;
    console.warn('[Telnyx Dialer] enumerateDevices is not available');
    return;
  }

  const selectedMicrophoneId = microphone.value || getSavedDeviceId(microphoneStorageKey);
  const selectedOutputId = audioOutput.value || getSavedDeviceId(audioOutputStorageKey);
  const devices = await navigator.mediaDevices.enumerateDevices();
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  const outputs = devices.filter((device) => device.kind === 'audiooutput');

  populateDeviceSelect(
    microphone,
    microphones,
    selectedMicrophoneId,
    'System default',
    'Microphone',
  );
  testMicButton.disabled = false;

  if (!supportsAudioOutputSelection()) {
    audioOutput.disabled = true;
    audioOutput.title = 'This browser does not support choosing an audio output device.';
    testSpeakerButton.disabled = false;
    console.warn('[Telnyx Dialer] Audio output selection is not supported by this browser');
  } else {
    populateDeviceSelect(audioOutput, outputs, selectedOutputId, 'System default', 'Speaker');
    testSpeakerButton.disabled = false;
  }

  console.info('[Telnyx Dialer] Audio devices refreshed', {
    selectedMicrophoneId: microphone.value || 'system-default',
    selectedOutputId: audioOutput.value || 'system-default',
    microphones: microphones.map((device, index) => ({
      deviceId: device.deviceId,
      label: getDeviceLabel(device, index, 'Microphone'),
    })),
    speakers: outputs.map((device, index) => ({
      deviceId: device.deviceId,
      label: getDeviceLabel(device, index, 'Speaker'),
    })),
  });
}

async function applyAudioOutput(deviceId) {
  if (!supportsAudioOutputSelection()) return;

  try {
    await remoteMedia.setSinkId(deviceId);
    audioOutput.value = deviceId;
    saveDeviceId(audioOutputStorageKey, deviceId);
    console.info('[Telnyx Dialer] Audio output selected', {
      deviceId: deviceId || 'system-default',
      sinkId: remoteMedia.sinkId || 'system-default',
    });
  } catch (error) {
    reportError('Unable to select audio output', error);
  }
}

function getSelectedMicrophoneId() {
  return microphone.value || '';
}

function getSelectedAudioConstraints() {
  const deviceId = getSelectedMicrophoneId();

  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

async function getMicrophoneStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: getSelectedAudioConstraints(),
  });
}

function getRemoteAudioStatus(context) {
  const tracks = remoteMedia.srcObject?.getAudioTracks?.() || [];

  return {
    context,
    sinkId: remoteMedia.sinkId || 'system-default',
    paused: remoteMedia.paused,
    muted: remoteMedia.muted,
    volume: remoteMedia.volume,
    readyState: remoteMedia.readyState,
    trackCount: tracks.length,
    tracks: tracks.map((track) => ({
      id: track.id,
      enabled: track.enabled,
      muted: track.muted,
      readyState: track.readyState,
    })),
  };
}

async function ensureRemoteAudioPlaying(context) {
  remoteMedia.muted = false;
  remoteMedia.volume = 1;

  try {
    await remoteMedia.play();
    console.info('[Telnyx Dialer] Remote audio playback checked', getRemoteAudioStatus(context));
  } catch (error) {
    reportError('Unable to play remote call audio', error);
  }
}

async function testSpeaker() {
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
    if (supportsAudioOutputSelection()) {
      await testAudio.setSinkId(audioOutput.value);
    }

    await context.resume();
    await testAudio.play();
    oscillator.start();
    setMessage(`Playing test tone through ${audioOutput.selectedOptions[0]?.text || 'system default'}...`);
    console.info('[Telnyx Dialer] Speaker test started', {
      deviceId: audioOutput.value || 'system-default',
      sinkId: testAudio.sinkId || 'system-default',
    });

    setTimeout(() => {
      oscillator.stop();
      testAudio.pause();
      destination.stream.getTracks().forEach((track) => track.stop());
      context.close();
      setMessage('Speaker test finished.');
    }, 900);
  } catch (error) {
    oscillator.disconnect();
    gain.disconnect();
    destination.stream.getTracks().forEach((track) => track.stop());
    context.close();
    reportError('Unable to test speaker', error);
  }
}

function stopMicTest() {
  if (!micTest) return;

  cancelAnimationFrame(micTest.animationFrame);
  micTest.stream.getTracks().forEach((track) => track.stop());
  micTest.context.close();
  micTest = null;
  micLevelBar.style.width = '0%';
  testMicButton.textContent = 'Test mic';
  setMessage('Microphone test stopped.');
}

async function startMicTest() {
  if (micTest) {
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

    micTest = {
      analyser,
      animationFrame: 0,
      context,
      stream,
    };

    testMicButton.textContent = 'Stop mic';
    setMessage(`Testing ${microphone.selectedOptions[0]?.text || 'system default'}...`);
    console.info('[Telnyx Dialer] Microphone test started', {
      deviceId: microphone.value || 'system-default',
    });

    const updateMeter = () => {
      analyser.getByteTimeDomainData(samples);
      const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample - 128)), 0);
      const percent = Math.min(100, Math.round((peak / 64) * 100));

      micLevelBar.style.width = `${percent}%`;
      micTest.animationFrame = requestAnimationFrame(updateMeter);
    };

    updateMeter();
  } catch (error) {
    reportError('Unable to test microphone', error);
  }
}

function clearError() {
  errorSummary.textContent = '';
  errorDetails.textContent = '';
  errorPanel.hidden = true;
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

  return {
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
  };
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined && entryValue !== ''),
  );
}

function showError(summary, details) {
  errorSummary.textContent = summary;
  errorDetails.textContent = JSON.stringify(compactObject(details), null, 2);
  errorPanel.hidden = false;
}

function reportError(summary, payload) {
  const details = getSerializableError(payload);
  const messageText = getErrorMessage(payload, summary);

  console.error(`[Telnyx Dialer] ${summary}`, payload);
  setMessage(messageText);
  showError(summary, details);
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

function hasCallFailure(call) {
  return Boolean(
    call?.sipCode >= 400 ||
      (!isNormalCallClearing(call) &&
        (call?.cause || call?.causeCode || call?.sipReason)),
  );
}

function isNormalCallClearing(call) {
  return call?.causeCode === 16 || call?.cause === 'NORMAL_CLEARING';
}

function formatCallFailure(call) {
  if (call?.sipCode && call?.sipReason) return `Call failed: ${call.sipCode} ${call.sipReason}`;
  if (call?.sipReason) return `Call failed: ${call.sipReason}`;
  if (call?.cause) return `Call ended: ${call.cause}`;
  return 'Call failed.';
}

function updateButtons() {
  callButton.disabled = isConnecting || Boolean(activeCall);
  hangupButton.disabled = !activeCall;
}

function getCallState(call) {
  return call?.state || call?.status || 'active';
}

function getCallStateLabel(call) {
  const state = getCallState(call);

  return callStateLabels[state] || state;
}

async function fetchCredentials() {
  const response = await fetch('/api/telnyx-credentials');
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(body.error || 'Unable to load Telnyx credentials.');
  }

  return body;
}

async function connect() {
  if (isReady) return client;
  if (isConnecting && connectPromise) return connectPromise;

  try {
    clearError();
    isConnecting = true;
    updateButtons();
    connectPromise = new Promise((resolve, reject) => {
      connectResolve = resolve;
      connectReject = reject;
    });
    setMessage('Requesting microphone access...');
    const permissionStream = await getMicrophoneStream();
    permissionStream.getTracks().forEach((track) => track.stop());
    await refreshAudioDevices();
    await applyAudioOutput(audioOutput.value);

    setConnectionStatus('Connecting');
    setMessage('Loading Telnyx credentials...');
    const credentials = await fetchCredentials();

    const clientOptions = credentials.login_token
      ? { login_token: credentials.login_token }
      : { login: credentials.login, password: credentials.password };

    client = new TelnyxRTC(clientOptions);

    client.remoteElement = 'remoteMedia';

    client
      .on('telnyx.ready', () => {
        isReady = true;
        isConnecting = false;
        setConnectionStatus('Ready');
        setMessage('Connected. Dialing...');
        clearError();
        updateButtons();
        connectResolve?.(client);
        connectPromise = null;
        connectResolve = null;
        connectReject = null;
      })
      .on('telnyx.error', (error) => {
        isConnecting = false;
        setConnectionStatus('Error');
        reportError('Telnyx connection error', error);
        updateButtons();
        connectReject?.(error);
        connectPromise = null;
        connectResolve = null;
        connectReject = null;
      })
      .on('telnyx.warning', (warning) => {
        console.warn('[Telnyx Dialer] Telnyx warning', warning);
      })
      .on('telnyx.socket.error', (error) => {
        reportError('Telnyx socket error', error);
      })
      .on('telnyx.socket.close', () => {
        console.info('[Telnyx Dialer] Telnyx socket closed');
        isReady = false;
        isConnecting = false;
        connectPromise = null;
        connectResolve = null;
        connectReject = null;
        setConnectionStatus('Disconnected');
        updateButtons();
      })
      .on('telnyx.rtc.mediaError', (error) => {
        reportError('Telnyx media error', error);
      })
      .on('telnyx.rtc.peerConnectionFailureError', (error) => {
        reportError('Telnyx peer connection error', error);
      })
      .on('telnyx.rtc.peerConnectionSignalingStateClosed', (error) => {
        reportError('Telnyx signaling state closed', error);
      })
      .on('telnyx.notification', (notification) => {
        if (notification.type !== 'callUpdate') return;

        activeCall = notification.call;
        const state = getCallState(activeCall);
        console.info('[Telnyx Dialer] Call update', summarizeCall(activeCall), notification);
        setCallStatus(getCallStateLabel(activeCall));

        if (playableCallStates.has(state)) {
          ensureRemoteAudioPlaying(getCallStateLabel(activeCall));
        }

        if (terminalCallStates.has(state)) {
          if (hasCallFailure(activeCall)) {
            const details = summarizeCall(activeCall);
            const summary = formatCallFailure(activeCall);
            console.error('[Telnyx Dialer] Call failure', details, notification);
            setMessage(summary);
            showError(summary, details);
          } else if (isNormalCallClearing(activeCall)) {
            console.info('[Telnyx Dialer] Call ended normally', summarizeCall(activeCall), notification);
            setMessage('Call ended normally.');
          }

          activeCall = null;
          setCallStatus('Idle');
        }

        updateButtons();
      });

    client.__callerNumber = credentials.callerNumber;
    console.info('[Telnyx Dialer] Connecting Telnyx client', {
      authMode: credentials.login_token ? 'login_token' : 'username_password',
      hasCallerNumber: Boolean(credentials.callerNumber),
    });
    client.connect();

    return connectPromise;
  } catch (error) {
    isConnecting = false;
    connectReject?.(error);
    connectPromise = null;
    connectResolve = null;
    connectReject = null;
    setConnectionStatus('Disconnected');
    reportError('Unable to connect Telnyx client', error);
    updateButtons();
    throw error;
  }
}

function placeCall(destinationNumber) {
  if (!client || !isReady) {
    reportError('Unable to place call', new Error('Telnyx client is not ready.'));
    return;
  }

  try {
    clearError();
    const callOptions = {
      destinationNumber,
      callerNumber: client.__callerNumber || undefined,
      audio: getSelectedAudioConstraints(),
      micId: getSelectedMicrophoneId() || undefined,
    };

    console.info('[Telnyx Dialer] Placing call', callOptions);
    activeCall = client.newCall(callOptions);
    console.info('[Telnyx Dialer] Call created', summarizeCall(activeCall));

    setCallStatus('Calling');
    setMessage(`Calling ${destinationNumber}...`);
    updateButtons();
  } catch (error) {
    activeCall = null;
    setCallStatus('Idle');
    reportError('Unable to place call', error);
    updateButtons();
  }
}

function hangup() {
  if (!activeCall) return;

  activeCall.hangup().catch((error) => {
    reportError('Unable to hang up call cleanly', error);
  });
  activeCall = null;
  setCallStatus('Idle');
  setMessage('Call ended.');
  updateButtons();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!phoneNumber.checkValidity()) {
    setMessage('Enter a phone number in E.164 format, for example +15551234567.');
    return;
  }

  const destinationNumber = phoneNumber.value.trim();

  try {
    if (!isReady) {
      setMessage('Connecting before dialing...');
      await connect();
    }

    placeCall(destinationNumber);
  } catch {
    // connect() already reported the visible error.
  }
});

hangupButton.addEventListener('click', hangup);

microphone.addEventListener('change', () => {
  saveDeviceId(microphoneStorageKey, microphone.value);
  stopMicTest();
  console.info('[Telnyx Dialer] Microphone selected', {
    deviceId: microphone.value || 'system-default',
  });

  if (activeCall?.setAudioInDevice && microphone.value) {
    activeCall.setAudioInDevice(microphone.value).catch((error) => {
      reportError('Unable to switch microphone for active call', error);
    });
  }
});

audioOutput.addEventListener('change', () => {
  applyAudioOutput(audioOutput.value);
});

testMicButton.addEventListener('click', startMicTest);
testSpeakerButton.addEventListener('click', testSpeaker);

navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  refreshAudioDevices().catch((error) => {
    reportError('Unable to refresh audio devices', error);
  });
});

window.addEventListener('beforeunload', () => {
  stopMicTest();
  activeCall?.hangup();
  client?.disconnect();
});

refreshAudioDevices().catch((error) => {
  console.warn('[Telnyx Dialer] Unable to refresh audio devices before permission', error);
});

updateButtons();
