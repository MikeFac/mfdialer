import express from 'express';
import { requireAppContext, clerkIsConfigured } from './auth.js';
import { prisma } from './db.js';
import { normalizePhoneNumber } from './phone.js';

export const apiRouter = express.Router();

apiRouter.use(express.json({ limit: '2mb' }));

async function getSuppressionForDial({ workspaceId, contactId, normalizedNumber }) {
  return prisma.suppressionEntry.findFirst({
    where: {
      workspaceId,
      type: 'do_not_call',
      OR: [
        normalizedNumber ? { normalizedNumber } : undefined,
        contactId ? { contactId, scope: 'contact' } : undefined,
      ].filter(Boolean),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function upsertPhoneNumber(workspaceId, rawNumber) {
  const normalized = normalizePhoneNumber(rawNumber);

  if (!normalized.normalizedNumber) return null;

  return prisma.phoneNumber.upsert({
    where: {
      workspaceId_normalizedNumber: {
        workspaceId,
        normalizedNumber: normalized.normalizedNumber,
      },
    },
    update: {
      rawNumber: normalized.rawNumber,
      countryCode: normalized.countryCode,
      isValid: normalized.isValid,
    },
    create: {
      workspaceId,
      rawNumber: normalized.rawNumber,
      normalizedNumber: normalized.normalizedNumber,
      countryCode: normalized.countryCode,
      isValid: normalized.isValid,
    },
  });
}

function serializeContact(contact) {
  return {
    id: contact.id,
    businessName: contact.businessName,
    contactName: contact.contactName,
    email: contact.email,
    website: contact.website,
    address: contact.address,
    city: contact.city,
    state: contact.state,
    status: contact.status,
    notes: contact.notes,
    phoneNumbers: contact.phoneNumbers?.map((entry) => ({
      id: entry.phoneNumber.id,
      rawNumber: entry.phoneNumber.rawNumber,
      normalizedNumber: entry.phoneNumber.normalizedNumber,
      isValid: entry.phoneNumber.isValid,
      label: entry.label,
      isPrimary: entry.isPrimary,
    })) || [],
  };
}

apiRouter.get('/me', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  res.json({
    authMode: context.authMode,
    clerkConfigured: clerkIsConfigured(),
    user: {
      id: context.user.id,
      email: context.user.email,
      name: context.user.name,
    },
    workspace: {
      id: context.workspace.id,
      name: context.workspace.name,
      slug: context.workspace.slug,
    },
  });
});

apiRouter.get('/dashboard', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const workspaceId = context.workspace.id;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    campaigns,
    contacts,
    callsToday,
    answeredToday,
    callbacksDue,
    dncCount,
    recentCalls,
  ] = await Promise.all([
    prisma.campaign.count({ where: { workspaceId, status: { not: 'archived' } } }),
    prisma.contact.count({ where: { workspaceId } }),
    prisma.callAttempt.count({ where: { workspaceId, startedAt: { gte: today } } }),
    prisma.callAttempt.count({ where: { workspaceId, startedAt: { gte: today }, answeredAt: { not: null } } }),
    prisma.callbackReminder.count({ where: { workspaceId, status: 'open', dueAt: { lte: new Date() } } }),
    prisma.suppressionEntry.count({ where: { workspaceId, type: 'do_not_call' } }),
    prisma.callAttempt.findMany({
      where: { workspaceId },
      orderBy: { startedAt: 'desc' },
      take: 8,
      include: {
        contact: true,
        phoneNumber: true,
        campaign: true,
      },
    }),
  ]);

  res.json({
    metrics: {
      campaigns,
      contacts,
      callsToday,
      answeredToday,
      callbacksDue,
      dncCount,
    },
    recentCalls: recentCalls.map((call) => ({
      id: call.id,
      startedAt: call.startedAt,
      status: call.status,
      outcome: call.outcome,
      contactName: call.contact?.businessName || call.contact?.contactName || 'Manual dial',
      number: call.phoneNumber?.normalizedNumber,
      campaignName: call.campaign?.name,
    })),
  });
});

apiRouter.get('/campaigns', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const campaigns = await prisma.campaign.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: {
          members: true,
          callAttempts: true,
        },
      },
    },
  });

  res.json({
    campaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      status: campaign.status,
      recordingDefault: campaign.recordingDefault,
      maxAttempts: campaign.maxAttempts,
      members: campaign._count.members,
      calls: campaign._count.callAttempts,
      createdAt: campaign.createdAt,
    })),
  });
});

apiRouter.post('/campaigns', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { name, description, recordingDefault = 'off', maxAttempts = 3 } = req.body || {};

  if (!name?.trim()) {
    return res.status(400).json({ error: 'Campaign name is required.' });
  }

  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: context.workspace.id,
      name: name.trim(),
      description: description?.trim() || null,
      recordingDefault,
      maxAttempts: Number(maxAttempts) || 3,
      createdByUserId: context.user.id,
      status: 'active',
    },
  });

  res.status(201).json({ campaign });
});

apiRouter.get('/contacts', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const search = String(req.query.search || '').trim();

  const contacts = await prisma.contact.findMany({
    where: {
      workspaceId: context.workspace.id,
      ...(search
        ? {
            OR: [
              { businessName: { contains: search } },
              { contactName: { contains: search } },
              { email: { contains: search } },
            ],
          }
        : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
    },
  });

  res.json({ contacts: contacts.map(serializeContact) });
});

apiRouter.post('/contacts', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const {
    businessName,
    contactName,
    email,
    website,
    address,
    city,
    state,
    notes,
    phoneNumbers = [],
    campaignId,
  } = req.body || {};

  if (!businessName?.trim()) {
    return res.status(400).json({ error: 'Business name is required.' });
  }

  const contact = await prisma.contact.create({
    data: {
      workspaceId: context.workspace.id,
      businessName: businessName.trim(),
      contactName: contactName?.trim() || null,
      email: email?.trim() || null,
      website: website?.trim() || null,
      address: address?.trim() || null,
      city: city?.trim() || null,
      state: state?.trim() || null,
      notes: notes?.trim() || null,
      status: campaignId ? 'queued' : 'new',
    },
  });

  const numbers = Array.isArray(phoneNumbers) ? phoneNumbers : [phoneNumbers];

  for (const [index, rawNumber] of numbers.filter(Boolean).entries()) {
    const phoneNumber = await upsertPhoneNumber(context.workspace.id, rawNumber);
    if (!phoneNumber) continue;

    await prisma.contactPhoneNumber.create({
      data: {
        workspaceId: context.workspace.id,
        contactId: contact.id,
        phoneNumberId: phoneNumber.id,
        label: index === 0 ? 'primary' : null,
        isPrimary: index === 0,
      },
    });
  }

  if (campaignId) {
    await prisma.campaignMember.upsert({
      where: {
        campaignId_contactId: {
          campaignId,
          contactId: contact.id,
        },
      },
      update: {},
      create: {
        workspaceId: context.workspace.id,
        campaignId,
        contactId: contact.id,
      },
    });
  }

  const created = await prisma.contact.findUnique({
    where: { id: contact.id },
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
    },
  });

  res.status(201).json({ contact: serializeContact(created) });
});

apiRouter.get('/campaigns/:id/queue/next', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const member = await prisma.campaignMember.findFirst({
    where: {
      workspaceId: context.workspace.id,
      campaignId: req.params.id,
      status: { in: ['queued', 'callback'] },
    },
    orderBy: [{ priority: 'desc' }, { lastAttemptAt: 'asc' }, { createdAt: 'asc' }],
    include: {
      campaign: true,
      contact: {
        include: {
          phoneNumbers: {
            include: { phoneNumber: true },
            orderBy: { isPrimary: 'desc' },
          },
        },
      },
    },
  });

  if (!member) return res.json({ member: null });

  res.json({
    member: {
      id: member.id,
      status: member.status,
      attemptCount: member.attemptCount,
      campaign: {
        id: member.campaign.id,
        name: member.campaign.name,
        recordingDefault: member.campaign.recordingDefault,
      },
      contact: serializeContact(member.contact),
    },
  });
});

apiRouter.post('/suppressions/check', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { phoneNumber, contactId } = req.body || {};
  const normalized = normalizePhoneNumber(phoneNumber);
  const suppression = await getSuppressionForDial({
    workspaceId: context.workspace.id,
    contactId,
    normalizedNumber: normalized.normalizedNumber,
  });

  res.json({
    allowed: !suppression,
    normalizedNumber: normalized.normalizedNumber,
    suppression,
  });
});

apiRouter.get('/suppressions', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const suppressions = await prisma.suppressionEntry.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      contact: true,
      phoneNumber: true,
      addedBy: true,
    },
  });

  res.json({ suppressions });
});

apiRouter.post('/suppressions', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { phoneNumber, contactId, type = 'do_not_call', scope = contactId ? 'contact' : 'number', reason, source = 'manual' } = req.body || {};
  let phoneRecord = null;
  let normalizedNumber = null;

  if (phoneNumber) {
    phoneRecord = await upsertPhoneNumber(context.workspace.id, phoneNumber);
    normalizedNumber = phoneRecord?.normalizedNumber || normalizePhoneNumber(phoneNumber).normalizedNumber;
  }

  if (!contactId && !normalizedNumber) {
    return res.status(400).json({ error: 'Provide a phone number or contact ID to suppress.' });
  }

  const suppression = await prisma.suppressionEntry.create({
    data: {
      workspaceId: context.workspace.id,
      phoneNumberId: phoneRecord?.id || null,
      contactId: contactId || null,
      normalizedNumber,
      type,
      reason: reason?.trim() || null,
      source,
      scope,
      addedByUserId: context.user.id,
    },
  });

  if (contactId && type === 'do_not_call') {
    await prisma.contact.update({
      where: { id: contactId },
      data: { status: 'do_not_call' },
    });
  }

  res.status(201).json({ suppression });
});

apiRouter.get('/call-attempts', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const calls = await prisma.callAttempt.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { startedAt: 'desc' },
    take: 100,
    include: {
      campaign: true,
      contact: true,
      phoneNumber: true,
      agent: true,
    },
  });

  res.json({ callAttempts: calls });
});

apiRouter.post('/call-attempts', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { phoneNumber, contactId, campaignId, campaignMemberId, recordingRequested = false, recordingConsentChecked = false } = req.body || {};
  const phoneRecord = phoneNumber ? await upsertPhoneNumber(context.workspace.id, phoneNumber) : null;
  const suppression = await getSuppressionForDial({
    workspaceId: context.workspace.id,
    contactId,
    normalizedNumber: phoneRecord?.normalizedNumber,
  });

  const callAttempt = await prisma.callAttempt.create({
    data: {
      workspaceId: context.workspace.id,
      campaignId: campaignId || null,
      campaignMemberId: campaignMemberId || null,
      contactId: contactId || null,
      phoneNumberId: phoneRecord?.id || null,
      agentUserId: context.user.id,
      status: suppression ? 'blocked' : 'preparing',
      recordingRequested: Boolean(recordingRequested),
      recordingConsentChecked: Boolean(recordingConsentChecked),
      blockedBySuppressionEntryId: suppression?.id || null,
      failureReason: suppression ? 'Blocked by do-not-call suppression.' : null,
    },
  });

  if (suppression) {
    return res.status(409).json({
      allowed: false,
      callAttempt,
      suppression,
      error: 'This number or contact is blocked by the DNC/suppression list.',
    });
  }

  res.status(201).json({ allowed: true, callAttempt, phoneNumber: phoneRecord });
});

apiRouter.patch('/call-attempts/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const allowed = [
    'status',
    'outcome',
    'answeredAt',
    'endedAt',
    'durationSeconds',
    'telnyxSessionId',
    'telnyxLegId',
    'telnyxCallControlId',
    'sipCode',
    'sipReason',
    'failureReason',
    'recordingRequested',
    'recordingConsentChecked',
  ];
  const data = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined),
  );

  for (const key of ['answeredAt', 'endedAt']) {
    if (data[key]) data[key] = new Date(data[key]);
  }

  const result = await prisma.callAttempt.updateMany({
    where: {
      id: req.params.id,
      workspaceId: context.workspace.id,
    },
    data,
  });

  if (result.count === 0) {
    return res.status(404).json({ error: 'Call attempt not found.' });
  }

  const callAttempt = await prisma.callAttempt.findUnique({
    where: { id: req.params.id },
  });

  res.json({ callAttempt });
});
