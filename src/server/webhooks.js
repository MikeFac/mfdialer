import crypto from 'node:crypto';
import { prisma } from './db.js';

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

export { EVENT_TYPES, deliverWithRetry };

const MAX_ATTEMPTS = 4;
const RETRY_DELAYS = [1000, 5000, 25000];

export async function fireEvent(workspaceId, eventType, data) {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { workspaceId, active: true },
    include: { subscriptions: true },
  });

  const matching = endpoints.filter((ep) => {
    if (ep.subscriptions.length === 0) return true;
    return ep.subscriptions.some((sub) => sub.eventType === eventType);
  });

  const payload = {
    event: eventType,
    deliveryId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    workspaceId,
    data,
  };

  const events = [];
  for (const endpoint of matching) {
    const event = await prisma.webhookEvent.create({
      data: {
        workspaceId,
        endpointId: endpoint.id,
        eventType,
        payload: JSON.stringify(payload),
        status: 'pending',
      },
    });
    events.push({ event, endpoint });
  }

  for (const { event, endpoint } of events) {
    deliverWithRetry(event.id, endpoint);
  }
}

async function deliverWithRetry(eventId, endpoint) {
  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const event = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      if (!event) return;
      const body = event.payload;
      const headers = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': event.eventType,
        'X-Webhook-Delivery': event.id,
        'X-Webhook-Timestamp': new Date().toISOString(),
      };
      if (endpoint.secret) {
        headers['X-Webhook-Signature'] = crypto
          .createHmac('sha256', endpoint.secret)
          .update(body)
          .digest('hex');
      }
      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      });
      await prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: response.ok ? 'delivered' : 'failed',
          attempts: attempt + 1,
          lastAttemptAt: new Date(),
          responseStatus: response.status,
        },
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (err) {
      lastError = err.message;
    }
    if (attempt < MAX_ATTEMPTS - 1 && RETRY_DELAYS[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
  await prisma.webhookEvent.update({
    where: { id: eventId },
    data: {
      status: 'failed',
      attempts: MAX_ATTEMPTS,
      lastAttemptAt: new Date(),
    },
  });
}

export async function buildCallPayload(callAttemptId) {
  const call = await prisma.callAttempt.findUnique({
    where: { id: callAttemptId },
    include: {
      contact: { include: { phoneNumbers: { include: { phoneNumber: true } } } },
      campaign: true,
      notes: { include: { author: true } },
      phoneNumber: true,
    },
  });
  if (!call) return null;

  const callback = await prisma.callbackReminder.findFirst({
    where: { contactId: call.contactId, status: 'open' },
    orderBy: { dueAt: 'asc' },
  });

  return {
    callAttempt: {
      id: call.id,
      direction: call.direction,
      status: call.status,
      outcome: call.outcome,
      startedAt: call.startedAt?.toISOString(),
      answeredAt: call.answeredAt?.toISOString(),
      endedAt: call.endedAt?.toISOString(),
      durationSeconds: call.durationSeconds,
      recordingRequested: call.recordingRequested,
    },
    contact: call.contact
      ? {
          id: call.contact.id,
          businessName: call.contact.businessName,
          contactName: call.contact.contactName,
          email: call.contact.email,
          phoneNumbers: call.contact.phoneNumbers.map((p) => ({
            normalizedNumber: p.phoneNumber.normalizedNumber,
            label: p.label,
            isPrimary: p.isPrimary,
          })),
        }
      : null,
    campaign: call.campaign
      ? { id: call.campaign.id, name: call.campaign.name }
      : null,
    notes: call.notes.map((n) => ({
      body: n.body,
      author: n.author?.email || null,
    })),
    callback: callback
      ? { id: callback.id, dueAt: callback.dueAt.toISOString(), note: callback.note }
      : null,
  };
}

export async function buildSuppressionPayload(suppressionId) {
  const sup = await prisma.suppressionEntry.findUnique({
    where: { id: suppressionId },
    include: { contact: true, phoneNumber: true },
  });
  if (!sup) return null;
  return {
    suppression: {
      id: sup.id,
      type: sup.type,
      scope: sup.scope,
      reason: sup.reason,
      source: sup.source,
    },
    contact: sup.contact
      ? { id: sup.contact.id, businessName: sup.contact.businessName, contactName: sup.contact.contactName }
      : null,
    phoneNumber: sup.phoneNumber
      ? { normalizedNumber: sup.phoneNumber.normalizedNumber }
      : sup.normalizedNumber
        ? { normalizedNumber: sup.normalizedNumber }
        : null,
  };
}