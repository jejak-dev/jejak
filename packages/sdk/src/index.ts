/**
 * Kontrak plugin Jejak (draf awal; belum stabil).
 * Lihat docs/ROADMAP.md bagian "SDK plugin".
 */

export type NodeKind = "service" | "table" | "collection" | "queue" | "contract" | "frontend";

export type EdgeKind = "reads" | "writes" | "publishes" | "consumes" | "calls";

/** Tingkat kepercayaan sebuah temuan, dari paling tinggi ke paling rendah. */
export type Confidence = "human-confirmed" | "code-derived" | "inferred";

export interface Provenance {
  repo: string;
  file?: string;
  commit?: string;
  observedAt: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  provenance: Provenance;
  confidence: Confidence;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  provenance: Provenance;
  confidence: Confidence;
}

export interface ExtractResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ExtractContext {
  repoPath: string;
  repoName: string;
  commit?: string;
}

/** Extractor membaca satu repo dan menghasilkan node serta garis untuk peta sistem. */
export interface Extractor {
  id: string;
  /** Apakah extractor ini relevan untuk repo ini? */
  detect(ctx: ExtractContext): Promise<boolean>;
  extract(ctx: ExtractContext): Promise<ExtractResult>;
}
