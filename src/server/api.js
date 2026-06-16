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
    doNotCall: contact.doNotCall,
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

apiRouter.patch('/campaigns/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const allowed = ['name', 'description', 'status', 'recordingDefault', 'maxAttempts'];
  const data = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined),
  );

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update.' });
  }

  const campaign = await prisma.campaign.updateMany({
    where: { id: req.params.id, workspaceId: context.workspace.id },
    data,
  });

  if (campaign.count === 0) {
    return res.status(404).json({ error: 'Campaign not found.' });
  }

  const updated = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  res.json({ campaign: updated });
});

apiRouter.patch('/campaigns/:campaignId/members/:memberId', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { status, nextCallbackAt } = req.body || {};
  const allowedStatuses = ['queued', 'callback', 'called', 'completed', 'skipped', 'blocked'];

  if (status && !allowedStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Allowed: ${allowedStatuses.join(', ')}` });
  }

  const member = await prisma.campaignMember.findFirst({
    where: { id: req.params.memberId, campaignId: req.params.campaignId, workspaceId: context.workspace.id },
  });

  if (!member) {
    return res.status(404).json({ error: 'Campaign member not found.' });
  }

  const updateData = {};
  if (status) updateData.status = status;
  if (nextCallbackAt) updateData.nextCallbackAt = new Date(nextCallbackAt);
  if (status === 'skipped' || status === 'completed' || status === 'blocked') {
    updateData.lastAttemptAt = new Date();
  }

  const updated = await prisma.campaignMember.update({
    where: { id: member.id },
    data: updateData,
  });

  res.json({ member: updated });
});

apiRouter.delete('/campaigns/:campaignId/members/:memberId', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const member = await prisma.campaignMember.findFirst({
    where: { id: req.params.memberId, campaignId: req.params.campaignId, workspaceId: context.workspace.id },
  });

  if (!member) {
    return res.status(404).json({ error: 'Campaign member not found.' });
  }

  await prisma.campaignMember.delete({ where: { id: member.id } });
  res.json({ deleted: true });
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

apiRouter.get('/contacts/duplicates', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const allContacts = await prisma.contact.findMany({
    where: { workspaceId: context.workspace.id },
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
    },
    orderBy: { businessName: 'asc' },
  });

  const phoneMap = new Map();
  for (const contact of allContacts) {
    for (const entry of contact.phoneNumbers) {
      const num = entry.phoneNumber.normalizedNumber;
      if (!num) continue;
      if (!phoneMap.has(num)) phoneMap.set(num, []);
      phoneMap.get(num).push(contact);
    }
  }

  const groups = [];
  const seen = new Set();
  for (const [, contacts] of phoneMap) {
    if (contacts.length < 2) continue;
    const ids = contacts.map((c) => c.id).sort();
    const key = ids.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push({
      phone: contacts[0].phoneNumbers[0]?.phoneNumber.normalizedNumber,
      contacts: contacts.map(serializeContact),
    });
  }

  const nameGroups = [];
  const nameMap = new Map();
  for (const contact of allContacts) {
    const key = contact.businessName.toLowerCase().trim();
    if (!key) continue;
    if (!nameMap.has(key)) nameMap.set(key, []);
    nameMap.get(key).push(contact);
  }
  for (const [, contacts] of nameMap) {
    if (contacts.length < 2) continue;
    const ids = contacts.map((c) => c.id).sort();
    const key = `name:${ids.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nameGroups.push({
      phone: null,
      name: contacts[0].businessName,
      contacts: contacts.map(serializeContact),
    });
  }

  res.json({ phoneDuplicates: groups, nameDuplicates: nameGroups });
});

apiRouter.post('/contacts/merge', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { primaryId, mergeIds } = req.body || {};
  if (!primaryId || !Array.isArray(mergeIds) || mergeIds.length === 0) {
    return res.status(400).json({ error: 'Provide primaryId and mergeIds array.' });
  }

  const allIds = [primaryId, ...mergeIds];
  const contacts = await prisma.contact.findMany({
    where: { id: { in: allIds }, workspaceId: context.workspace.id },
    include: {
      phoneNumbers: { include: { phoneNumber: true } },
      campaignMembers: true,
      callAttempts: true,
      suppressions: true,
      callNotes: true,
      callbacks: true,
    },
  });

  const primary = contacts.find((c) => c.id === primaryId);
  if (!primary) {
    return res.status(404).json({ error: 'Primary contact not found.' });
  }

  const toMerge = contacts.filter((c) => c.id !== primaryId);
  const mergeData = { ...primary };

  for (const contact of toMerge) {
    if (!mergeData.contactName && contact.contactName) mergeData.contactName = contact.contactName;
    if (!mergeData.email && contact.email) mergeData.email = contact.email;
    if (!mergeData.website && contact.website) mergeData.website = contact.website;
    if (!mergeData.address && contact.address) mergeData.address = contact.address;
    if (!mergeData.city && contact.city) mergeData.city = contact.city;
    if (!mergeData.state && contact.state) mergeData.state = contact.state;
    if (!mergeData.notes && contact.notes) mergeData.notes = contact.notes;

    for (const entry of contact.phoneNumbers) {
      const existingLink = await prisma.contactPhoneNumber.findFirst({
        where: { contactId: primary.id, phoneNumberId: entry.phoneNumberId },
      });
      if (!existingLink) {
        await prisma.contactPhoneNumber.create({
          data: {
            workspaceId: context.workspace.id,
            contactId: primary.id,
            phoneNumberId: entry.phoneNumberId,
            label: entry.label,
            isPrimary: false,
          },
        });
      }
    }

    await prisma.campaignMember.updateMany({
      where: { contactId: contact.id, workspaceId: context.workspace.id },
      data: { contactId: primary.id },
    });

    await prisma.callAttempt.updateMany({
      where: { contactId: contact.id, workspaceId: context.workspace.id },
      data: { contactId: primary.id },
    });

    await prisma.callNote.updateMany({
      where: { contactId: contact.id, workspaceId: context.workspace.id },
      data: { contactId: primary.id },
    });

    await prisma.callbackReminder.updateMany({
      where: { contactId: contact.id, workspaceId: context.workspace.id },
      data: { contactId: primary.id },
    });

    await prisma.suppressionEntry.updateMany({
      where: { contactId: contact.id, workspaceId: context.workspace.id },
      data: { contactId: primary.id },
    });

    await prisma.contact.delete({ where: { id: contact.id } });
  }

  const fillData = {};
  for (const [field, value] of Object.entries(mergeData)) {
    if (['id', 'workspaceId', 'createdAt', 'updatedAt', 'phoneNumbers', 'campaignMembers', 'callAttempts', 'callNotes', 'callbacks', 'suppressions', 'tags'].includes(field)) continue;
    if (value && !primary[field]) fillData[field] = value;
  }

  if (Object.keys(fillData).length > 0) {
    await prisma.contact.update({ where: { id: primary.id }, data: fillData });
  }

  const updated = await prisma.contact.findUnique({
    where: { id: primary.id },
    include: {
      phoneNumbers: { include: { phoneNumber: true }, orderBy: { isPrimary: 'desc' } },
    },
  });

  res.json({ contact: serializeContact(updated), merged: mergeIds.length });
});

apiRouter.get('/contacts/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const contact = await prisma.contact.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
      suppressions: {
        where: { type: 'do_not_call' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      callAttempts: {
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: {
          phoneNumber: true,
          campaign: true,
          notes: {
            include: { author: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
      campaignMembers: {
        include: { campaign: true },
      },
      callbacks: {
        orderBy: { dueAt: 'asc' },
        include: { phoneNumber: true },
      },
    },
  });

  if (!contact) {
    return res.status(404).json({ error: 'Contact not found.' });
  }

  res.json({
    contact: serializeContact(contact),
    doNotCallSuppression: contact.suppressions[0] || null,
    callAttempts: contact.callAttempts.map((call) => ({
      id: call.id,
      status: call.status,
      outcome: call.outcome,
      startedAt: call.startedAt,
      answeredAt: call.answeredAt,
      endedAt: call.endedAt,
      durationSeconds: call.durationSeconds,
      failureReason: call.failureReason,
      phoneNumber: call.phoneNumber?.normalizedNumber,
      campaignName: call.campaign?.name,
      notes: call.notes.map((note) => ({
        id: note.id,
        body: note.body,
        author: note.author?.email || null,
        createdAt: note.createdAt,
      })),
    })),
    campaigns: contact.campaignMembers.map((member) => ({
      id: member.campaign.id,
      name: member.campaign.name,
      status: member.status,
      attemptCount: member.attemptCount,
    })),
    callbacks: contact.callbacks.map((cb) => ({
      id: cb.id,
      dueAt: cb.dueAt,
      status: cb.status,
      note: cb.note,
      phoneNumber: cb.phoneNumber?.normalizedNumber,
    })),
  });
});

apiRouter.patch('/contacts/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const allowed = ['businessName', 'contactName', 'email', 'website', 'address', 'city', 'state', 'status', 'doNotCall', 'notes'];
  const data = Object.fromEntries(
    Object.entries(req.body || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined),
  );

  if (data.doNotCall !== undefined) {
    data.doNotCall = Boolean(data.doNotCall);
  }

  const contact = await prisma.contact.updateMany({
    where: { id: req.params.id, workspaceId: context.workspace.id },
    data,
  });

  if (contact.count === 0) {
    return res.status(404).json({ error: 'Contact not found.' });
  }

  const updated = await prisma.contact.findUnique({
    where: { id: req.params.id },
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
    },
  });

  res.json({ contact: serializeContact(updated) });
});

apiRouter.post('/call-attempts/:id/notes', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const callAttempt = await prisma.callAttempt.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });

  if (!callAttempt) {
    return res.status(404).json({ error: 'Call attempt not found.' });
  }

  const { body, contactId } = req.body || {};
  if (!body?.trim()) {
    return res.status(400).json({ error: 'Note body is required.' });
  }

  const note = await prisma.callNote.create({
    data: {
      workspaceId: context.workspace.id,
      callAttemptId: callAttempt.id,
      contactId: contactId || callAttempt.contactId,
      authorUserId: context.user.id,
      body: body.trim(),
    },
  });

  res.status(201).json({ note });
});

apiRouter.post('/call-attempts/:id/outcome', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { outcome, notes, doNotCall, callbackDueAt, callbackNote, contactId } = req.body || {};
  const callAttempt = await prisma.callAttempt.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });

  if (!callAttempt) {
    return res.status(404).json({ error: 'Call attempt not found.' });
  }

  const updateData = {};
  if (outcome) {
    updateData.outcome = outcome;
    updateData.status = 'completed';
    updateData.endedAt = new Date();
  }

  if (callAttempt.contactId && doNotCall) {
    await prisma.contact.update({
      where: { id: callAttempt.contactId },
      data: { doNotCall: true, status: 'do_not_call' },
    });

    const contactNumbers = callAttempt.phoneNumberId
      ? [{ phoneNumberId: callAttempt.phoneNumberId }]
      : await prisma.contactPhoneNumber.findMany({
          where: { contactId: callAttempt.contactId },
          select: { phoneNumberId: true, phoneNumber: { select: { normalizedNumber: true } } },
        });

    for (const cn of contactNumbers) {
      const phone = await prisma.phoneNumber.findUnique({ where: { id: cn.phoneNumberId } });
      if (!phone?.normalizedNumber) continue;
      const existing = await prisma.suppressionEntry.findFirst({
        where: { workspaceId: context.workspace.id, type: 'do_not_call', normalizedNumber: phone.normalizedNumber },
      });
      if (existing) continue;
      await prisma.suppressionEntry.create({
        data: {
          workspaceId: context.workspace.id,
          phoneNumberId: phone.id,
          contactId: callAttempt.contactId,
          normalizedNumber: phone.normalizedNumber,
          type: 'do_not_call',
          reason: 'Requested via call outcome',
          source: 'call_outcome',
          scope: 'contact',
          addedByUserId: context.user.id,
        },
      });
    }
  }

  if (outcome) {
    await prisma.callAttempt.updateMany({
      where: { id: callAttempt.id, workspaceId: context.workspace.id },
      data: updateData,
    });
  }

  if (notes?.trim()) {
    await prisma.callNote.create({
      data: {
        workspaceId: context.workspace.id,
        callAttemptId: callAttempt.id,
        contactId: contactId || callAttempt.contactId,
        authorUserId: context.user.id,
        body: notes.trim(),
      },
    });
  }

  if (callbackDueAt && contactId) {
    await prisma.callbackReminder.create({
      data: {
        workspaceId: context.workspace.id,
        contactId: contactId,
        campaignMemberId: callAttempt.campaignMemberId,
        phoneNumberId: callAttempt.phoneNumberId,
        assignedToUserId: context.user.id,
        dueAt: new Date(callbackDueAt),
        status: 'open',
        note: callbackNote?.trim() || null,
      },
    });
  }

  const updated = await prisma.callAttempt.findUnique({ where: { id: callAttempt.id } });
  res.json({ callAttempt: updated });
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

apiRouter.get('/campaigns/:id/members', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const members = await prisma.campaignMember.findMany({
    where: {
      campaignId: req.params.id,
      workspaceId: context.workspace.id,
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    include: {
      contact: {
        include: {
          phoneNumbers: {
            include: { phoneNumber: true },
            orderBy: { isPrimary: 'desc' },
          },
        },
      },
      callAttempts: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        select: {
          id: true,
          startedAt: true,
          outcome: true,
          status: true,
        },
      },
    },
  });

  res.json({
    members: members.map((member) => ({
      id: member.id,
      status: member.status,
      attemptCount: member.attemptCount,
      createdAt: member.createdAt,
      lastAttemptAt: member.lastAttemptAt,
      contact: serializeContact(member.contact),
      lastCall: member.callAttempts[0]
        ? {
            id: member.callAttempts[0].id,
            startedAt: member.callAttempts[0].startedAt,
            outcome: member.callAttempts[0].outcome,
            status: member.callAttempts[0].status,
          }
        : null,
    })),
  });
});

apiRouter.post('/campaigns/:id/import', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const campaign = await prisma.campaign.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found.' });
  }

  const { contacts } = req.body || {};

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Provide a contacts array with at least one contact.' });
  }

  const importBatch = await prisma.importBatch.create({
    data: {
      workspaceId: context.workspace.id,
      campaignId: campaign.id,
      filename: null,
      status: 'committed',
      totalRows: contacts.length,
      committedRows: 0,
      invalidRows: 0,
      duplicateRows: 0,
      suppressedRows: 0,
    },
  });

  let committedRows = 0;
  let invalidRows = 0;
  let duplicateRows = 0;
  let suppressedRows = 0;
  const results = [];

  for (let i = 0; i < contacts.length; i++) {
    const row = contacts[i];
    const phoneNumbers = Array.isArray(row.phoneNumbers) ? row.phoneNumbers : row.phoneNumbers ? [row.phoneNumbers] : [];
    const businessName = (row.businessName || row.name || '').trim();

    if (!businessName) {
      invalidRows++;
      await prisma.importRow.create({
        data: {
          workspaceId: context.workspace.id,
          importBatchId: importBatch.id,
          rowIndex: i,
          rawData: JSON.stringify(row),
          status: 'invalid',
          message: 'Business name is required.',
        },
      });
      continue;
    }

    const normalizedNumbers = phoneNumbers
      .filter(Boolean)
      .map((n) => normalizePhoneNumber(n))
      .filter((n) => n.normalizedNumber);

    if (normalizedNumbers.length === 0) {
      invalidRows++;
      await prisma.importRow.create({
        data: {
          workspaceId: context.workspace.id,
          importBatchId: importBatch.id,
          rowIndex: i,
          rawData: JSON.stringify(row),
          status: 'invalid',
          message: 'At least one valid phone number is required.',
        },
      });
      continue;
    }

    let contact = null;

    const matchingPhone = await prisma.contactPhoneNumber.findFirst({
      where: {
        workspaceId: context.workspace.id,
        phoneNumber: { normalizedNumber: { in: normalizedNumbers.map((n) => n.normalizedNumber) } },
      },
      include: { contact: true },
    });

    if (matchingPhone) {
      contact = matchingPhone.contact;
      const updateData = {};
      const fields = [
        ['businessName', row.businessName || row.name],
        ['contactName', row.contactName],
        ['email', row.email],
        ['website', row.website],
        ['address', row.address],
        ['city', row.city],
        ['state', row.state],
        ['notes', row.notes],
      ];
      for (const [field, value] of fields) {
        if (value?.trim() && !contact[field]?.trim()) {
          updateData[field] = value.trim();
        }
      }
      if (Object.keys(updateData).length > 0) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: updateData,
        });
      }

      for (const normalized of normalizedNumbers) {
        const existingLink = await prisma.contactPhoneNumber.findFirst({
          where: { contactId: contact.id, phoneNumberId: (await prisma.phoneNumber.findUnique({ where: { workspaceId_normalizedNumber: { workspaceId: context.workspace.id, normalizedNumber: normalized.normalizedNumber } } }))?.id },
        });
        if (!existingLink) {
          const phoneNumber = await upsertPhoneNumber(context.workspace.id, normalized.rawNumber);
          if (phoneNumber) {
            await prisma.contactPhoneNumber.create({
              data: {
                workspaceId: context.workspace.id,
                contactId: contact.id,
                phoneNumberId: phoneNumber.id,
                label: null,
                isPrimary: false,
              },
            });
          }
        }
      }

      duplicateRows++;
    } else {
      contact = await prisma.contact.create({
        data: {
          workspaceId: context.workspace.id,
          businessName,
          contactName: (row.contactName || null),
          email: (row.email || null),
          website: (row.website || null),
          address: (row.address || null),
          city: (row.city || null),
          state: (row.state || null),
          notes: (row.notes || null),
          status: 'queued',
        },
      });

      for (const [index, normalized] of normalizedNumbers.entries()) {
        const phoneNumber = await upsertPhoneNumber(context.workspace.id, normalized.rawNumber);
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

      committedRows++;
    }

    await prisma.campaignMember.upsert({
      where: {
        campaignId_contactId: {
          campaignId: campaign.id,
          contactId: contact.id,
        },
      },
      update: {},
      create: {
        workspaceId: context.workspace.id,
        campaignId: campaign.id,
        contactId: contact.id,
      },
    });

    await prisma.importRow.create({
      data: {
        workspaceId: context.workspace.id,
        importBatchId: importBatch.id,
        rowIndex: i,
        rawData: JSON.stringify(row),
        status: matchingPhone ? 'duplicate' : 'committed',
        message: matchingPhone ? `Merged into existing contact: ${contact.businessName}` : null,
      },
    });

    results.push({ id: contact.id, businessName: contact.businessName, merged: !!matchingPhone });
  }

  await prisma.importBatch.update({
    where: { id: importBatch.id },
    data: {
      committedRows,
      invalidRows,
      duplicateRows,
      suppressedRows,
    },
  });

  res.status(201).json({
    importBatch: { id: importBatch.id, totalRows: contacts.length, committedRows, invalidRows, duplicateRows },
    contacts: results,
  });
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
