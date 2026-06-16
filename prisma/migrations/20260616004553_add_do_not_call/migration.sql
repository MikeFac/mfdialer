-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactName" TEXT,
    "email" TEXT,
    "website" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "doNotCall" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Contact" ("address", "businessName", "city", "contactName", "createdAt", "email", "id", "notes", "state", "status", "updatedAt", "website", "workspaceId") SELECT "address", "businessName", "city", "contactName", "createdAt", "email", "id", "notes", "state", "status", "updatedAt", "website", "workspaceId" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE INDEX "Contact_workspaceId_businessName_idx" ON "Contact"("workspaceId", "businessName");
CREATE INDEX "Contact_workspaceId_status_idx" ON "Contact"("workspaceId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
