-- CreateTable
CREATE TABLE "mockup_templates" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productType" TEXT NOT NULL,
    "colour" TEXT NOT NULL,
    "dpiHint" INTEGER NOT NULL DEFAULT 300,
    "quad" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mockup_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mockup_templates_filename_key" ON "mockup_templates"("filename");
