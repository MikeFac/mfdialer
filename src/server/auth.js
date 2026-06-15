import { getAuth, clerkClient } from '@clerk/express';
import { prisma } from './db.js';

const DEFAULT_OWNER_EMAIL = process.env.DEFAULT_WORKSPACE_OWNER_EMAIL || 'michaelfackerell@gmail.com';
const DEFAULT_WORKSPACE_SLUG = 'default';

function isClerkConfigured() {
  return Boolean(process.env.CLERK_SECRET_KEY);
}

function isLocalAuthFallbackEnabled() {
  return process.env.NODE_ENV !== 'production' && !isClerkConfigured();
}

function getPrimaryEmail(clerkUser) {
  const primaryEmailId = clerkUser.primaryEmailAddressId;
  const primary = clerkUser.emailAddresses?.find((email) => email.id === primaryEmailId);

  return primary?.emailAddress || clerkUser.emailAddresses?.[0]?.emailAddress || null;
}

async function getRequestIdentity(req) {
  if (isLocalAuthFallbackEnabled()) {
    return {
      clerkUserId: 'local-dev-user',
      email: DEFAULT_OWNER_EMAIL,
      name: 'Michael Fackerell',
      authMode: 'local-dev',
    };
  }

  const auth = getAuth(req);

  if (!auth.userId) return null;

  const clerkUser = await clerkClient.users.getUser(auth.userId);
  const email = getPrimaryEmail(clerkUser);

  if (!email) return null;

  return {
    clerkUserId: auth.userId,
    email,
    name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || email,
    authMode: 'clerk',
  };
}

async function ensureUser(identity) {
  return prisma.user.upsert({
    where: { clerkUserId: identity.clerkUserId },
    update: {
      email: identity.email,
      name: identity.name,
    },
    create: {
      clerkUserId: identity.clerkUserId,
      email: identity.email,
      name: identity.name,
    },
  });
}

async function ensureDefaultWorkspace(user) {
  const workspace = await prisma.workspace.upsert({
    where: { slug: DEFAULT_WORKSPACE_SLUG },
    update: {},
    create: {
      name: 'Default Workspace',
      slug: DEFAULT_WORKSPACE_SLUG,
    },
  });

  await prisma.workspaceMembership.upsert({
    where: {
      workspaceId_userId: {
        workspaceId: workspace.id,
        userId: user.id,
      },
    },
    update: {
      role: user.email === DEFAULT_OWNER_EMAIL ? 'owner' : 'agent',
    },
    create: {
      workspaceId: workspace.id,
      userId: user.id,
      role: user.email === DEFAULT_OWNER_EMAIL ? 'owner' : 'agent',
    },
  });

  return workspace;
}

export async function getAppContext(req) {
  const identity = await getRequestIdentity(req);

  if (!identity) return null;

  const user = await ensureUser(identity);
  const workspace = await ensureDefaultWorkspace(user);

  return {
    authMode: identity.authMode,
    user,
    workspace,
  };
}

export async function requireAppContext(req, res) {
  const context = await getAppContext(req);

  if (!context) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }

  return context;
}

export function clerkIsConfigured() {
  return isClerkConfigured();
}
