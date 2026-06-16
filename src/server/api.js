import express from 'express';
import crypto from 'node:crypto';
import { requireAppContext, clerkIsConfigured } from './auth.js';
import { prisma } from './db.js';
import { normalizePhoneNumber } from './phone.js';
import { EVENT_TYPES, fireEvent, deliverWithRetry, buildCallPayload, buildSuppressionPayload } from './webhooks.js';

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
  const from = req.query.from ? new Date(req.query.from) : undefined;
  const to = req.query.to ? new Date(req.query.to) : undefined;
  if (from) from.setHours(0, 0, 0, 0);
  if (to) to.setHours(23, 59, 59, 999);

  const dateFilter = {
    ...(from && { gte: from }),
    ...(to && { lte: to }),
  };
  const callDateWhere = Object.keys(dateFilter).length > 0 ? { startedAt: dateFilter } : {};

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);

  const [
    campaigns,
    contacts,
    callsToday,
    answeredToday,
    callbacksDue,
    dncCount,
    recentCalls,
    totalCalls,
    totalAnswered,
    avgDuration,
    outcomeCounts,
    trendData,
  ] = await Promise.all([
    prisma.campaign.count({ where: { workspaceId, status: { not: 'archived' } } }),
    prisma.contact.count({ where: { workspaceId } }),
    prisma.callAttempt.count({ where: { workspaceId, startedAt: { gte: today } } }),
    prisma.callAttempt.count({ where: { workspaceId, startedAt: { gte: today }, answeredAt: { not: null } } }),
    prisma.callbackReminder.count({ where: { workspaceId, status: 'open', dueAt: { lte: new Date() } } }),
    prisma.suppressionEntry.count({ where: { workspaceId, type: 'do_not_call' } }),
    prisma.callAttempt.findMany({
      where: { workspaceId, ...callDateWhere },
      orderBy: { startedAt: 'desc' },
      take: 10,
      include: { contact: true, phoneNumber: true, campaign: true },
    }),
    prisma.callAttempt.count({ where: { workspaceId, ...callDateWhere } }),
    prisma.callAttempt.count({ where: { workspaceId, ...callDateWhere, answeredAt: { not: null } } }),
    prisma.callAttempt.aggregate({
      where: { workspaceId, ...callDateWhere, answeredAt: { not: null }, durationSeconds: { not: null } },
      _avg: { durationSeconds: true },
    }),
    prisma.callAttempt.groupBy({
      by: ['outcome'],
      where: { workspaceId, ...callDateWhere, outcome: { not: null } },
      _count: { outcome: true },
    }),
    prisma.$queryRaw`
      SELECT DATE(startedAt) as date, COUNT(*) as count
      FROM CallAttempt
      WHERE workspaceId = ${workspaceId}
        AND startedAt >= ${sevenDaysAgo}
      GROUP BY DATE(startedAt)
      ORDER BY DATE(startedAt) ASC
    `,
  ]);

  const contactRate = totalCalls > 0
    ? Math.round((outcomeCounts
        .filter((o) => ['interested', 'callback_requested', 'needs_follow_up'].includes(o.outcome))
        .reduce((sum, o) => sum + o._count.outcome, 0) / totalCalls) * 100)
    : 0;

  const outcomeBreakdown = {};
  for (const o of outcomeCounts) {
    outcomeBreakdown[o.outcome] = o._count.outcome;
  }

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = d.toISOString().slice(0, 10);
    const row = trendData.find((r) => String(r.date).slice(0, 10) === ds);
    trend.push({ date: ds, count: row ? Number(row.count) : 0 });
  }

  res.json({
    metrics: {
      campaigns,
      contacts,
      callsToday,
      answeredToday,
      callbacksDue,
      dncCount,
      totalCalls,
      totalAnswered,
      answerRate: totalCalls > 0 ? Math.round((totalAnswered / totalCalls) * 100) : 0,
      contactRate,
      avgDuration: Math.round(avgDuration._avg.durationSeconds || 0),
      outcomeBreakdown,
      trend,
    },
    recentCalls: recentCalls.map((call) => ({
      id: call.id,
      startedAt: call.startedAt,
      status: call.status,
      outcome: call.outcome,
      contactName: call.contact?.businessName || call.contact?.contactName || 'Manual dial',
      number: call.phoneNumber?.normalizedNumber,
      campaignName: call.campaign?.name,
      durationSeconds: call.durationSeconds,
    })),
  });
});

apiRouter.get('/reports/summary/export', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const workspaceId = context.workspace.id;
  const from = req.query.from ? new Date(req.query.from) : undefined;
  const to = req.query.to ? new Date(req.query.to) : undefined;
  if (from) from.setHours(0, 0, 0, 0);
  if (to) to.setHours(23, 59, 59, 999);
  const dateFilter = { ...(from && { gte: from }), ...(to && { lte: to }) };
  const callDateWhere = Object.keys(dateFilter).length > 0 ? { startedAt: dateFilter } : {};

  const [totalCalls, totalAnswered, avgDur, outcomes] = await Promise.all([
    prisma.callAttempt.count({ where: { workspaceId, ...callDateWhere } }),
    prisma.callAttempt.count({ where: { workspaceId, ...callDateWhere, answeredAt: { not: null } } }),
    prisma.callAttempt.aggregate({
      where: { workspaceId, ...callDateWhere, answeredAt: { not: null }, durationSeconds: { not: null } },
      _avg: { durationSeconds: true },
    }),
    prisma.callAttempt.groupBy({
      by: ['outcome'],
      where: { workspaceId, ...callDateWhere, outcome: { not: null } },
      _count: { outcome: true },
    }),
  ]);

  const rows = [
    ['Metric', 'Value'],
    ['Total Calls', totalCalls],
    ['Answered Calls', totalAnswered],
    ['Answer Rate', totalCalls > 0 ? `${Math.round((totalAnswered / totalCalls) * 100)}%` : '0%'],
    ['Avg Duration (s)', Math.round(avgDur._avg.durationSeconds || 0)],
    ...outcomes.map((o) => [o.outcome, o._count.outcome]),
  ];

  const csv = rows.map((r) => r.join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="summary-report.csv"');
  res.send(csv);
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

apiRouter.get('/reports/campaign/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { id } = req.params;
  const from = req.query.from ? new Date(req.query.from) : undefined;
  const to = req.query.to ? new Date(req.query.to) : undefined;
  if (from) from.setHours(0, 0, 0, 0);
  if (to) to.setHours(23, 59, 59, 999);

  const dateFilter = {
    ...(from && { gte: from }),
    ...(to && { lte: to }),
  };
  const callDateWhere = Object.keys(dateFilter).length > 0 ? { startedAt: dateFilter } : {};

  const campaign = await prisma.campaign.findFirst({
    where: { id, workspaceId: context.workspace.id },
    include: {
      members: { select: { status: true } },
    },
  });

  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const memberStatusCounts = {};
  for (const m of campaign.members) {
    memberStatusCounts[m.status] = (memberStatusCounts[m.status] || 0) + 1;
  }

  const [
    totalCalls,
    answeredCalls,
    avgDuration,
    outcomeCounts,
    dncBlocked,
  ] = await Promise.all([
    prisma.callAttempt.count({ where: { workspaceId: context.workspace.id, campaignId: id, ...callDateWhere } }),
    prisma.callAttempt.count({ where: { workspaceId: context.workspace.id, campaignId: id, ...callDateWhere, answeredAt: { not: null } } }),
    prisma.callAttempt.aggregate({
      where: { workspaceId: context.workspace.id, campaignId: id, ...callDateWhere, answeredAt: { not: null }, durationSeconds: { not: null } },
      _avg: { durationSeconds: true },
    }),
    prisma.callAttempt.groupBy({
      by: ['outcome'],
      where: { workspaceId: context.workspace.id, campaignId: id, ...callDateWhere, outcome: { not: null } },
      _count: { outcome: true },
    }),
    prisma.callAttempt.count({ where: { workspaceId: context.workspace.id, campaignId: id, ...callDateWhere, status: 'blocked' } }),
  ]);

  const outcomeBreakdown = {};
  for (const o of outcomeCounts) {
    outcomeBreakdown[o.outcome] = o._count.outcome;
  }

  const contactRate = totalCalls > 0
    ? Math.round((outcomeCounts
        .filter((o) => ['interested', 'callback_requested', 'needs_follow_up'].includes(o.outcome))
        .reduce((sum, o) => sum + o._count.outcome, 0) / totalCalls) * 100)
    : 0;

  res.json({
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      totalMembers: campaign.members.length,
      memberStatusCounts,
    },
    stats: {
      totalCalls,
      answeredCalls,
      answerRate: totalCalls > 0 ? Math.round((answeredCalls / totalCalls) * 100) : 0,
      contactRate,
      avgDuration: Math.round(avgDuration._avg.durationSeconds || 0),
      dncBlocked,
      outcomeBreakdown,
    },
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

apiRouter.get('/contacts/export', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const contacts = await prisma.contact.findMany({
    where: { workspaceId: context.workspace.id },
    include: {
      phoneNumbers: {
        include: { phoneNumber: true },
        orderBy: { isPrimary: 'desc' },
      },
      campaignMembers: { include: { campaign: true } },
    },
    orderBy: { businessName: 'asc' },
  });

  const rows = contacts.map((c) => ({
    id: c.id,
    businessName: c.businessName,
    contactName: c.contactName || '',
    email: c.email || '',
    website: c.website || '',
    phone: c.phoneNumbers.map((p) => p.phoneNumber.normalizedNumber).join('; '),
    address: c.address || '',
    city: c.city || '',
    state: c.state || '',
    status: c.status,
    doNotCall: c.doNotCall ? 'yes' : 'no',
    notes: (c.notes || '').replace(/"/g, '""'),
    campaigns: c.campaignMembers.map((m) => m.campaign.name).join('; '),
  }));

  const headers = ['id', 'businessName', 'contactName', 'email', 'website', 'phone', 'address', 'city', 'state', 'status', 'doNotCall', 'notes', 'campaigns'];
  const csv = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => {
      const val = String(r[h] ?? '');
      return val.includes(',') || val.includes('\n') || val.includes('"') ? `"${val}"` : val;
    }).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send(csv);
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

  if (outcome) {
    fireEvent(context.workspace.id, 'call.completed', await buildCallPayload(callAttempt.id));
    if (outcome === 'answered') {
      fireEvent(context.workspace.id, 'call.answered', await buildCallPayload(callAttempt.id));
    }
    if (['interested', 'callback_requested', 'not_interested', 'do_not_call'].includes(outcome)) {
      fireEvent(context.workspace.id, `call.outcome.${outcome}`, await buildCallPayload(callAttempt.id));
    }
  }

  if (doNotCall && callAttempt.contactId) {
    const phone = callAttempt.phoneNumberId
      ? await prisma.phoneNumber.findUnique({ where: { id: callAttempt.phoneNumberId } })
      : null;
    fireEvent(context.workspace.id, 'contact.dnc_added', {
      suppression: { type: 'do_not_call', scope: 'contact', reason: 'Requested via call outcome', source: 'call_outcome' },
      contact: { id: callAttempt.contactId },
      phoneNumber: phone ? { normalizedNumber: phone.normalizedNumber } : null,
    });
  }

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

apiRouter.get('/suppressions/export', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const suppressions = await prisma.suppressionEntry.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { createdAt: 'desc' },
    include: {
      contact: true,
      phoneNumber: true,
      addedBy: true,
    },
  });

  const headers = ['id', 'normalizedNumber', 'type', 'scope', 'reason', 'source', 'contactName', 'businessName', 'addedBy', 'createdAt'];
  const csv = [
    headers.join(','),
    ...suppressions.map((s) => headers.map((h) => {
      let val;
      switch (h) {
        case 'contactName': val = s.contact?.contactName || ''; break;
        case 'businessName': val = s.contact?.businessName || ''; break;
        case 'addedBy': val = s.addedBy?.email || ''; break;
        default: val = String(s[h] ?? '');
      }
      return val.includes(',') || val.includes('\n') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dnc-suppressions.csv"');
  res.send(csv);
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

  fireEvent(context.workspace.id, 'contact.dnc_added', await buildSuppressionPayload(suppression.id));

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

apiRouter.get('/call-attempts/export', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const calls = await prisma.callAttempt.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { startedAt: 'desc' },
    include: {
      campaign: true,
      contact: true,
      phoneNumber: true,
      agent: true,
    },
  });

  const headers = ['id', 'startedAt', 'contactName', 'businessName', 'phoneNumber', 'status', 'outcome', 'durationSeconds', 'campaign', 'agent', 'failureReason'];
  const csv = [
    headers.join(','),
    ...calls.map((c) => headers.map((h) => {
      let val;
      switch (h) {
        case 'contactName': val = c.contact?.contactName || ''; break;
        case 'businessName': val = c.contact?.businessName || ''; break;
        case 'phoneNumber': val = c.phoneNumber?.normalizedNumber || ''; break;
        case 'campaign': val = c.campaign?.name || ''; break;
        case 'agent': val = c.agent?.email || ''; break;
        default: val = String(c[h] ?? '');
      }
      return val.includes(',') || val.includes('\n') || val.includes('"') ? `"${val.replace(/"/g, '""')}"` : val;
    }).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="call-history.csv"');
  res.send(csv);
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

// ─── Webhook Endpoints ───────────────────────────────────────────────────

// (webhooks module imported at top of file)

apiRouter.get('/webhooks', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { workspaceId: context.workspace.id },
    include: { subscriptions: true },
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    endpoints: endpoints.map((ep) => ({
      id: ep.id,
      name: ep.name,
      url: ep.url,
      secretHint: ep.secret ? ep.secret.slice(-4).padStart(ep.secret.length, '*') : null,
      active: ep.active,
      subscriptions: ep.subscriptions.map((s) => s.eventType),
      createdAt: ep.createdAt,
    })),
  });
});

apiRouter.post('/webhooks', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { name, url, secret, active = true, subscriptions = [] } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });
  if (!url?.trim()) return res.status(400).json({ error: 'URL is required.' });

  try {
    new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid URL.' });
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      workspaceId: context.workspace.id,
      name: name.trim(),
      url: url.trim(),
      secret: secret || null,
      active,
      subscriptions: {
        create: subscriptions
          .filter((t) => EVENT_TYPES.includes(t))
          .map((t) => ({ eventType: t })),
      },
    },
    include: { subscriptions: true },
  });

  res.status(201).json({
    endpoint: {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      active: endpoint.active,
      subscriptions: endpoint.subscriptions.map((s) => s.eventType),
    },
  });
});

apiRouter.patch('/webhooks/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { name, url, secret, active } = req.body || {};
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!existing) return res.status(404).json({ error: 'Endpoint not found.' });

  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (url !== undefined) {
    try { new URL(url.trim()); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
    data.url = url.trim();
  }
  if (secret !== undefined) data.secret = secret || null;
  if (active !== undefined) data.active = active;

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: req.params.id },
    data,
    include: { subscriptions: true },
  });

  res.json({
    endpoint: {
      id: endpoint.id,
      name: endpoint.name,
      url: endpoint.url,
      active: endpoint.active,
      subscriptions: endpoint.subscriptions.map((s) => s.eventType),
    },
  });
});

apiRouter.delete('/webhooks/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!existing) return res.status(404).json({ error: 'Endpoint not found.' });

  await prisma.webhookEndpoint.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

apiRouter.post('/webhooks/:id/subscriptions', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { subscriptions = [] } = req.body || {};
  const existing = await prisma.webhookEndpoint.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!existing) return res.status(404).json({ error: 'Endpoint not found.' });

  await prisma.webhookSubscription.deleteMany({ where: { endpointId: req.params.id } });
  await prisma.webhookSubscription.createMany({
    data: subscriptions
      .filter((t) => EVENT_TYPES.includes(t))
      .map((t) => ({ endpointId: req.params.id, eventType: t })),
  });

  const endpoint = await prisma.webhookEndpoint.findUnique({
    where: { id: req.params.id },
    include: { subscriptions: true },
  });
  res.json({ subscriptions: endpoint.subscriptions.map((s) => s.eventType) });
});

apiRouter.get('/webhooks/events', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const events = await prisma.webhookEvent.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { endpoint: { select: { name: true, url: true } } },
  });

  res.json({
    events: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      status: e.status,
      attempts: e.attempts,
      responseStatus: e.responseStatus,
      lastAttemptAt: e.lastAttemptAt,
      createdAt: e.createdAt,
      endpoint: { name: e.endpoint.name, url: e.endpoint.url },
    })),
  });
});

apiRouter.get('/webhooks/events/:id', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const event = await prisma.webhookEvent.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
    include: { endpoint: { select: { name: true, url: true } } },
  });
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  res.json({ event: { ...event, endpoint: { name: event.endpoint.name, url: event.endpoint.url } } });
});

apiRouter.post('/webhooks/events/:id/retry', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const event = await prisma.webhookEvent.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!event) return res.status(404).json({ error: 'Event not found.' });

  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: event.endpointId } });
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found.' });

  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: { status: 'pending', attempts: 0 },
  });

  deliverWithRetry(event.id, endpoint);

  res.json({ success: true });
});

apiRouter.post('/webhooks/:id/test', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found.' });

  const testPayload = {
    event: 'call.completed',
    deliveryId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    workspaceId: context.workspace.id,
    data: {
      callAttempt: { id: 'test', direction: 'outbound', status: 'completed', outcome: 'interested', durationSeconds: 60 },
      contact: { id: 'test', businessName: 'Test Business', contactName: 'Test Contact' },
      campaign: null,
      notes: [],
      callback: null,
    },
  };

  const event = await prisma.webhookEvent.create({
    data: {
      workspaceId: context.workspace.id,
      endpointId: endpoint.id,
      eventType: 'call.completed',
      payload: JSON.stringify(testPayload),
      status: 'pending',
    },
  });

  deliverWithRetry(event.id, endpoint);

  res.json({ success: true, message: 'Test event queued for delivery.' });
});

apiRouter.post('/webhooks/:id/trigger', async (req, res) => {
  const context = await requireAppContext(req, res);
  if (!context) return;

  const { callAttemptId, eventType = 'call.completed' } = req.body || {};
  if (!callAttemptId) return res.status(400).json({ error: 'callAttemptId is required.' });

  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: req.params.id, workspaceId: context.workspace.id },
  });
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found.' });

  const data = await buildCallPayload(callAttemptId);
  if (!data) return res.status(404).json({ error: 'Call attempt not found.' });

  await fireEvent(context.workspace.id, eventType, data);
  res.json({ success: true });
});
