-- CreateEnum
CREATE TYPE "PDFType" AS ENUM ('NATIVE_DIGITAL', 'SCANNED_IMAGE', 'HYBRID', 'VECTOR_TEXT', 'ENCRYPTED', 'CORRUPTED');

-- CreateEnum
CREATE TYPE "LayoutType" AS ENUM ('SINGLE_COLUMN', 'TWO_COLUMN', 'THREE_COLUMN', 'SIDEBAR_LEFT', 'SIDEBAR_RIGHT', 'MIXED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ExtractionEngine" AS ENUM ('PYMUPDF', 'PDFMINER', 'PDFPLUMBER', 'MARKER', 'OCRMYPDF_TESSERACT', 'MISTRAL_OCR', 'GOOGLE_DOCUMENT_AI', 'AMAZON_TEXTRACT', 'AZURE_DOCUMENT_INTELLIGENCE', 'ADOBE_PDF_EXTRACT', 'LLAMAPARSE', 'UNSTRUCTURED');

-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'TIMEOUT');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "filename" TEXT NOT NULL,
    "sha256Hash" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "pdfType" "PDFType",
    "layoutType" "LayoutType",
    "hasTextLayer" BOOLEAN,
    "hasFontEmbeds" BOOLEAN,
    "hasImages" BOOLEAN,
    "isEncrypted" BOOLEAN NOT NULL DEFAULT false,
    "hasInvisibleText" BOOLEAN NOT NULL DEFAULT false,
    "hasDuplicateLayers" BOOLEAN NOT NULL DEFAULT false,
    "numericDensity" DOUBLE PRECISION,
    "originalStoragePath" TEXT NOT NULL,
    "groundTruthStoragePath" TEXT,
    "edgeCaseTags" TEXT[],
    "stratumId" TEXT,
    "sourceSystem" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroundTruth" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "documentId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "sectionsJson" JSONB,
    "numericEntities" JSONB,
    "derivationMethod" TEXT NOT NULL,
    "vlmSimilarityScore" DOUBLE PRECISION,
    "validatedBy" TEXT,
    "validatedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,

    CONSTRAINT "GroundTruth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionResult" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "documentId" TEXT NOT NULL,
    "engine" "ExtractionEngine" NOT NULL,
    "engineVersion" TEXT,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PENDING',
    "rawText" TEXT,
    "rawMarkdown" TEXT,
    "rawJson" JSONB,
    "processingTimeMs" INTEGER,
    "charCount" INTEGER,
    "wordCount" INTEGER,
    "pageCount" INTEGER,
    "extractionConfidence" DOUBLE PRECISION,
    "garbleRatio" DOUBLE PRECISION,
    "whitespaceRatio" DOUBLE PRECISION,
    "duplicateBlockRatio" DOUBLE PRECISION,
    "numericAnomalyDetected" BOOLEAN NOT NULL DEFAULT false,
    "wasFallback" BOOLEAN NOT NULL DEFAULT false,
    "costUsd" DOUBLE PRECISION,
    "apiCallCount" INTEGER,
    "errorMessage" TEXT,
    "stackTrace" TEXT,

    CONSTRAINT "ExtractionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "documentId" TEXT NOT NULL,
    "runLabel" TEXT,
    "enginesIncluded" "ExtractionEngine"[],

    CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkMetric" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "benchmarkRunId" TEXT NOT NULL,
    "extractionResultId" TEXT NOT NULL,
    "engine" "ExtractionEngine" NOT NULL,
    "cer" DOUBLE PRECISION,
    "wer" DOUBLE PRECISION,
    "charPrecision" DOUBLE PRECISION,
    "charRecall" DOUBLE PRECISION,
    "charF1" DOUBLE PRECISION,
    "readingOrderScore" DOUBLE PRECISION,
    "blockCount" INTEGER,
    "misorientedBlockCount" INTEGER,
    "numericAccuracyAggregate" DOUBLE PRECISION,
    "phoneAccuracy" DOUBLE PRECISION,
    "dateAccuracy" DOUBLE PRECISION,
    "emailAccuracy" DOUBLE PRECISION,
    "urlAccuracy" DOUBLE PRECISION,
    "percentageAccuracy" DOUBLE PRECISION,
    "salaryAccuracy" DOUBLE PRECISION,
    "versionAccuracy" DOUBLE PRECISION,
    "sectionRecall" DOUBLE PRECISION,
    "sectionPrecision" DOUBLE PRECISION,
    "sectionF1" DOUBLE PRECISION,
    "tableAccuracy" DOUBLE PRECISION,
    "noiseRate" DOUBLE PRECISION,
    "duplicationRate" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "costUsd" DOUBLE PRECISION,
    "compositeScore" DOUBLE PRECISION,

    CONSTRAINT "BenchmarkMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_sha256Hash_key" ON "Document"("sha256Hash");

-- CreateIndex
CREATE INDEX "Document_pdfType_layoutType_idx" ON "Document"("pdfType", "layoutType");

-- CreateIndex
CREATE INDEX "Document_sha256Hash_idx" ON "Document"("sha256Hash");

-- CreateIndex
CREATE INDEX "Document_stratumId_idx" ON "Document"("stratumId");

-- CreateIndex
CREATE UNIQUE INDEX "GroundTruth_documentId_key" ON "GroundTruth"("documentId");

-- CreateIndex
CREATE INDEX "GroundTruth_documentId_idx" ON "GroundTruth"("documentId");

-- CreateIndex
CREATE INDEX "ExtractionResult_documentId_idx" ON "ExtractionResult"("documentId");

-- CreateIndex
CREATE INDEX "ExtractionResult_engine_status_idx" ON "ExtractionResult"("engine", "status");

-- CreateIndex
CREATE INDEX "ExtractionResult_extractionConfidence_idx" ON "ExtractionResult"("extractionConfidence");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionResult_documentId_engine_key" ON "ExtractionResult"("documentId", "engine");

-- CreateIndex
CREATE INDEX "BenchmarkRun_documentId_idx" ON "BenchmarkRun"("documentId");

-- CreateIndex
CREATE INDEX "BenchmarkMetric_benchmarkRunId_idx" ON "BenchmarkMetric"("benchmarkRunId");

-- CreateIndex
CREATE INDEX "BenchmarkMetric_engine_idx" ON "BenchmarkMetric"("engine");

-- CreateIndex
CREATE INDEX "BenchmarkMetric_compositeScore_idx" ON "BenchmarkMetric"("compositeScore");

-- AddForeignKey
ALTER TABLE "GroundTruth" ADD CONSTRAINT "GroundTruth_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionResult" ADD CONSTRAINT "ExtractionResult_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkRun" ADD CONSTRAINT "BenchmarkRun_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkMetric" ADD CONSTRAINT "BenchmarkMetric_benchmarkRunId_fkey" FOREIGN KEY ("benchmarkRunId") REFERENCES "BenchmarkRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenchmarkMetric" ADD CONSTRAINT "BenchmarkMetric_extractionResultId_fkey" FOREIGN KEY ("extractionResultId") REFERENCES "ExtractionResult"("id") ON DELETE CASCADE ON UPDATE CASCADE;
