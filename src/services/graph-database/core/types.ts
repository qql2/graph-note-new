export interface GraphNode {
  id?: string;
  type: string;
  label: string;
  properties?: Record<string, any>;
  is_independent?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface GraphEdge {
  id?: string;
  source_id: string;
  target_id: string;
  type: string;
  properties?: Record<string, any>;
  created_at?: string;
  isStructured?: boolean;
  structuredMeta?: {
    relationshipNodeId: string;
    relayEdgeIds: [string, string];
    label: string;
    properties: Record<string, any>;
  };
}

// 导出选项接口
export interface ExportOptions {
  prettyPrint?: boolean;
  includeMetadata?: boolean;
}

// 导入模式枚举
export enum ImportMode {
  REPLACE = "replace",
  MERGE = "merge",
}

// 导入结果接口
export interface ImportResult {
  success: boolean;
  nodesImported: number;
  edgesImported: number;
  errors: string[];
}

// 验证结果接口
export interface ValidationResult {
  valid: boolean;
  version?: string;
  nodeCount: number;
  edgeCount: number;
  errors: string[];
  metadata?: Record<string, any>; // Additional metadata for validation results
}

export interface DatabaseConfig {
  storage_path?: string;
  verbose?: boolean;
  dbName?: string;
  version?: number;
}

export interface Operation {
  type: "query" | "run";
  sql: string;
  params?: any[];
}

export interface SQLiteEngine {
  query(sql: string, params?: any[]): Promise<{ values?: any[] }>;
  run(sql: string, params?: any[]): Promise<void>;
  isOpen(): boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  beginTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  transaction<T>(operation: () => T | Promise<T>): Promise<T>;
  export(): Uint8Array;
}

export enum DeleteMode {
  CASCADE = "CASCADE",
  KEEP_CONNECTED = "KEEP_CONNECTED",
}

export interface GraphDatabaseInterface {
  db: SQLiteEngine;
  initialize(config: DatabaseConfig): Promise<void>;
  close(): Promise<void>;
  addNode(node: Omit<GraphNode, "created_at" | "updated_at">): Promise<string>;
  updateNode(id: string, updates: Partial<GraphNode>): Promise<void>;
  deleteNode(id: string, mode?: DeleteMode): Promise<void>;
  getNodes(): Promise<GraphNode[]>;
  getNode(id: string): Promise<GraphNode>;
  addEdge(edge: Omit<GraphEdge, "created_at">): Promise<string>;
  deleteEdge(id: string): Promise<void>;
  getEdges(): Promise<GraphEdge[]>;
  getEdge(id: string): Promise<GraphEdge>;
  updateEdge(id: string, updates: Partial<GraphEdge>): Promise<void>;
  findPath(
    startId: string,
    endId: string,
    maxDepth?: number
  ): Promise<GraphEdge[]>;
  findConnectedNodes(nodeId: string, depth?: number): Promise<GraphNode[]>;
  getEdgesForNode(nodeId: string): Promise<GraphEdge[]>;
  getEdgesBetweenNodes(
    sourceId: string,
    targetId: string
  ): Promise<GraphEdge[]>;
  exportToJson(options?: ExportOptions): Promise<string>;
  importFromJson(jsonData: string, mode: ImportMode): Promise<ImportResult>;
  validateImportData(jsonData: string): Promise<ValidationResult>;
  clear(): Promise<void>;
  exportData(): Promise<Uint8Array>;
  importData(data: Uint8Array): Promise<void>;
  createBackup(): Promise<string>;
  restoreFromBackup(backupId: string): Promise<void>;
  listBackups(): Promise<string[]>;

  // 新增搜索相关方法
  searchNodes(
    criteria: any
  ): Promise<{ nodes: GraphNode[]; totalCount: number }>;
  searchEdges(
    criteria: any
  ): Promise<{ edges: GraphEdge[]; totalCount: number }>;
  fullTextSearch(
    query: string,
    options?: any
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    totalNodeCount: number;
    totalEdgeCount: number;
  }>;

  // New method for finding parent independent node
  findParentIndependentNode(nodeId: string): Promise<GraphNode | null>;

  // Method to create a structured relationship
  createStructuredRelationship(
    sourceNodeId: string,
    targetNodeId: string,
    relationshipLabel: string,
    properties?: Record<string, any>
  ): Promise<string>;

  // Method to convert an existing edge to a structured relationship
  convertToStructuredRelationship(
    edgeId: string,
    relationshipLabel?: string,
    properties?: Record<string, any>
  ): Promise<string>;

  // Method to move all relationships from one node to another, handling both structured and regular relationships
  moveRelationships(fromNodeId: string, toNodeId: string): Promise<void>;

  // Self-check API to validate structured relationships integrity
  validateStructuredRelationships(): Promise<ValidationResult>;
}
