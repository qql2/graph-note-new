import { v4 as uuidv4 } from "uuid";
import {
  GraphNode,
  GraphEdge,
  GraphDatabaseInterface,
  DatabaseConfig,
  SQLiteEngine,
  DeleteMode,
} from "./types";
import { DATABASE_SCHEMA } from "./schema";
import {
  DatabaseError,
  NodeNotFoundError,
  EdgeNotFoundError,
  ValidationError,
  TransactionError,
} from "./errors";

// TODO: 嵌套事务的处理交给transaction Service

export abstract class BaseGraphDB implements GraphDatabaseInterface {
  protected db: SQLiteEngine | null = null;
  protected config: DatabaseConfig | null = null;
  protected initialized = false;

  // 抽象方法：由具体平台实现
  protected abstract createEngine(config: DatabaseConfig): Promise<SQLiteEngine>;
  protected abstract persistData(): Promise<void>;

  async initialize(config: DatabaseConfig): Promise<void> {
    if (this.initialized) return;

    try {
      this.config = config;
      this.db = await this.createEngine(config);
      await this.setupDatabase();
      this.initialized = true;
    } catch (error) {
      console.error("Database initialization error:", error);
      throw error
    }
  }

  protected async setupDatabase(): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      await this.db.transaction(async () => {
        // 创建表
        for (const createTable of DATABASE_SCHEMA.createTables) {
          await this.db!.run(createTable);
        }
        // 创建索引
        for (const createIndex of DATABASE_SCHEMA.createIndexes) {
          await this.db!.run(createIndex);
        }
      });
    } catch (error) {
      throw error
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
        this.db = null;
        this.initialized = false;
      } catch (error) {
        throw new DatabaseError("Failed to close database", error as Error);
      }
    }
  }

  // 事务支持 - 这些方法现在是抽象的，由具体平台实现
  async beginTransaction(): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    await this.db.beginTransaction();
  }

  async commitTransaction(): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    await this.db.commitTransaction();
  }

  async rollbackTransaction(): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    await this.db.rollbackTransaction();
  }

  // 判断是否在事务中 - 这个方法也由具体平台实现
  protected get inTransaction(): boolean {
    // 这个需要在具体实现中提供，默认返回false
    return false;
  }

  // 不要再额外包一层了, 直接用db.transaction方法
  protected async withTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    
    // 直接使用db.transaction方法，该方法会在具体实现中提供
    try {
      return await this.db.transaction(operation);
    } catch (error) {
      throw error;
    }
  }

  // 节点操作
  async addNode(node: Omit<GraphNode, "created_at" | "updated_at">): Promise<string> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    
    const id = node.id || uuidv4();
    const now = new Date().toISOString();

    // 定义添加节点的操作
    const addNodeOperation = async (db: SQLiteEngine) => {
      // 插入节点基本信息
      await db.run(
        `INSERT INTO nodes (id, type, label, x, y, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, node.type, node.label, node.x, node.y, now, now]
      );

      // 插入节点属性
      if (node.properties) {
        for (const [key, value] of Object.entries(node.properties)) {
          await db.run(
            `INSERT INTO node_properties (node_id, key, value)
             VALUES (?, ?, ?)`,
            [id, key, JSON.stringify(value)]
          );
        }
      }

      return id;
    };

    // 使用事务执行操作
    try {
      return await this.withTransaction(async () => {
        try {
          return await addNodeOperation(this.db!);
        } catch (error) {
          throw new DatabaseError(`Failed to add node: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async updateNode(id: string, updates: Partial<GraphNode>): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // 创建更新操作的函数
    const updateOperation = async (db: SQLiteEngine) => {
      // 检查节点是否存在
      const nodeExistsResult = await db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [id]
      );
      
      if (!nodeExistsResult?.values || nodeExistsResult.values.length === 0) {
        throw new NodeNotFoundError(id);
      }

      // 更新节点基本属性
      if (
        updates.label !== undefined ||
        updates.type !== undefined ||
        updates.x !== undefined ||
        updates.y !== undefined
      ) {
        const sets: string[] = [];
        const params: any[] = [];

        if (updates.label !== undefined) {
          sets.push("label = ?");
          params.push(updates.label);
        }
        if (updates.type !== undefined) {
          sets.push("type = ?");
          params.push(updates.type);
        }
        if (updates.x !== undefined) {
          sets.push("x = ?");
          params.push(updates.x);
        }
        if (updates.y !== undefined) {
          sets.push("y = ?");
          params.push(updates.y);
        }

        if (sets.length > 0) {
          sets.push("updated_at = ?");
          params.push(new Date().toISOString());
          params.push(id);

          await db.run(
            `UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`,
            params
          );
        }
      }

      // 更新节点属性
      if (updates.properties) {
        // 删除现有属性
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
        
        // 插入新属性
        for (const [key, value] of Object.entries(updates.properties)) {
          await db.run(
            `INSERT INTO node_properties (node_id, key, value)
             VALUES (?, ?, ?)`,
            [id, key, JSON.stringify(value)]
          );
        }
      }
    };

    try {
      // 如果已经在事务中，直接执行操作
      if (this.inTransaction) {
        try {
          await updateOperation(this.db);
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to update node: ${error}`, error as Error);
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await updateOperation(this.db!);
          await this.persistData();
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to update node: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async deleteNode(id: string, mode: DeleteMode = DeleteMode.KEEP_CONNECTED): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // 创建删除操作的函数
    const deleteOperation = async (db: SQLiteEngine) => {
      // 检查节点是否存在
      const nodeExistsResult = await db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [id]
      );
      
      if (!nodeExistsResult?.values || nodeExistsResult.values.length === 0) {
        throw new NodeNotFoundError(id);
      }

      if (mode === DeleteMode.CASCADE) {
        // 级联删除模式：删除所有相关数据
        // 1. 删除与节点相关的所有边的属性
        await db.run(
          `DELETE FROM relationship_properties 
           WHERE relationship_id IN (
             SELECT id FROM relationships 
             WHERE source_id = ? OR target_id = ?
           )`,
          [id, id]
        );

        // 2. 删除与节点相关的所有边
        await db.run(
          "DELETE FROM relationships WHERE source_id = ? OR target_id = ?",
          [id, id]
        );

        // 3. 删除节点的属性
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);

        // 4. 删除节点本身
        await db.run("DELETE FROM nodes WHERE id = ?", [id]);
      } else {
        // 保留关联数据模式：只删除节点本身和它的属性
        // 1. 删除节点的属性
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);

        // 2. 将相关边的源节点或目标节点设为 NULL
        await db.run(
          `UPDATE relationships 
           SET source_id = NULL 
           WHERE source_id = ?`,
          [id]
        );
        await db.run(
          `UPDATE relationships 
           SET target_id = NULL 
           WHERE target_id = ?`,
          [id]
        );

        // 3. 删除节点本身
        await db.run("DELETE FROM nodes WHERE id = ?", [id]);
      }
    };

    try {
      // 如果已经在事务中，直接执行操作
      if (this.inTransaction) {
        try {
          await deleteOperation(this.db);
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to delete node: ${error}`, error as Error);
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await deleteOperation(this.db!);
          await this.persistData();
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to delete node: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async getNodes(): Promise<GraphNode[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 获取所有节点基本信息
      const nodesResult = await this.db.query("SELECT * FROM nodes");
      
      if (!nodesResult?.values || nodesResult.values.length === 0) {
        return [];
      }

      const nodes: GraphNode[] = [];
      
      for (const node of nodesResult.values) {


        // 获取节点属性
        // console.log('node', node);
        const propsResult = await this.db.query(
          "SELECT key, value FROM node_properties WHERE node_id = ?",
          [node.id]
        );
        
        if (propsResult?.values && propsResult.values.length > 0) {
          for (const propRow of propsResult.values) {
            try {
              node.properties![propRow[0]] = JSON.parse(propRow[1]);
            } catch (e) {
              node.properties![propRow[0]] = propRow[1];
            }
          }
        }

        nodes.push(node);
      }

      return nodes;
    } catch (error) {
      throw new DatabaseError(`Failed to get nodes: ${error}`, error as Error);
    }
  }

  // 边操作
  async addEdge(edge: Omit<GraphEdge, "created_at">): Promise<string> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    
    const id = edge.id || uuidv4();
    const now = new Date().toISOString();

    // 创建添加边的操作
    const addEdgeOperation = async (db: SQLiteEngine): Promise<string> => {
      // 验证源节点和目标节点存在
      if (edge.source_id) {
        const sourceExistsResult = await db.query(
          "SELECT 1 FROM nodes WHERE id = ?",
          [edge.source_id]
        );
        
        if (!sourceExistsResult?.values || sourceExistsResult.values.length === 0) {
          throw new NodeNotFoundError(edge.source_id);
        }
      }
      
      if (edge.target_id) {
        const targetExistsResult = await db.query(
          "SELECT 1 FROM nodes WHERE id = ?",
          [edge.target_id]
        );
        
        if (!targetExistsResult?.values || targetExistsResult.values.length === 0) {
          throw new NodeNotFoundError(edge.target_id);
        }
      }

      // 插入边基本信息
      await db.run(
        `INSERT INTO relationships (id, source_id, target_id, type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, edge.source_id, edge.target_id, edge.type, now]
      );

      // 插入边属性
      if (edge.properties) {
        for (const [key, value] of Object.entries(edge.properties)) {
          await db.run(
            `INSERT INTO relationship_properties (relationship_id, key, value)
             VALUES (?, ?, ?)`,
            [id, key, JSON.stringify(value)]
          );
        }
      }

      return id;
    };

    try {
      // 如果已经在事务中，直接执行操作
      if (this.inTransaction) {
        try {
          return await addEdgeOperation(this.db);
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to add edge: ${error}`, error as Error);
        }
      }

      // 否则，使用事务执行操作
      return await this.db.transaction(async () => {
        try {
          const result = await addEdgeOperation(this.db!);
          await this.persistData();
          return result;
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to add edge: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async updateEdge(id: string, updates: Partial<GraphEdge>): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // 创建更新边的操作
    const updateEdgeOperation = async (db: SQLiteEngine): Promise<void> => {
      // 检查边是否存在
      const edgeExistsResult = await db.query(
        "SELECT 1 FROM relationships WHERE id = ?",
        [id]
      );
      
      if (!edgeExistsResult?.values || edgeExistsResult.values.length === 0) {
        throw new EdgeNotFoundError(id);
      }

      // 更新边基本属性
      if (
        updates.source_id !== undefined ||
        updates.target_id !== undefined ||
        updates.type !== undefined
      ) {
        // 验证源节点和目标节点
        if (updates.source_id) {
          const sourceExistsResult = await db.query(
            "SELECT 1 FROM nodes WHERE id = ?",
            [updates.source_id]
          );
          
          if (!sourceExistsResult?.values || sourceExistsResult.values.length === 0) {
            throw new NodeNotFoundError(updates.source_id);
          }
        }
        
        if (updates.target_id) {
          const targetExistsResult = await db.query(
            "SELECT 1 FROM nodes WHERE id = ?",
            [updates.target_id]
          );
          
          if (!targetExistsResult?.values || targetExistsResult.values.length === 0) {
            throw new NodeNotFoundError(updates.target_id);
          }
        }

        const sets: string[] = [];
        const params: any[] = [];

        if (updates.source_id !== undefined) {
          sets.push("source_id = ?");
          params.push(updates.source_id);
        }
        if (updates.target_id !== undefined) {
          sets.push("target_id = ?");
          params.push(updates.target_id);
        }
        if (updates.type !== undefined) {
          sets.push("type = ?");
          params.push(updates.type);
        }

        if (sets.length > 0) {
          params.push(id);
          await db.run(
            `UPDATE relationships SET ${sets.join(", ")} WHERE id = ?`,
            params
          );
        }
      }

      // 更新边属性
      if (updates.properties) {
        // 删除现有属性
        await db.run(
          "DELETE FROM relationship_properties WHERE relationship_id = ?", 
          [id]
        );
        
        // 插入新属性
        for (const [key, value] of Object.entries(updates.properties)) {
          await db.run(
            `INSERT INTO relationship_properties (relationship_id, key, value)
             VALUES (?, ?, ?)`,
            [id, key, JSON.stringify(value)]
          );
        }
      }
    };

    try {
      // 如果已经在事务中，直接执行操作
      if (this.inTransaction) {
        try {
          await updateEdgeOperation(this.db);
        } catch (error) {
          if (error instanceof NodeNotFoundError || error instanceof EdgeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to update edge: ${error}`, error as Error);
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await updateEdgeOperation(this.db!);
          await this.persistData();
        } catch (error) {
          if (error instanceof NodeNotFoundError || error instanceof EdgeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to update edge: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async deleteEdge(id: string): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // 创建删除边的操作
    const deleteEdgeOperation = async (db: SQLiteEngine): Promise<void> => {
      // 检查边是否存在
      const edgeExistsResult = await db.query(
        "SELECT 1 FROM relationships WHERE id = ?",
        [id]
      );
      
      if (!edgeExistsResult?.values || edgeExistsResult.values.length === 0) {
        throw new EdgeNotFoundError(id);
      }

      // 删除边属性
      await db.run(
        "DELETE FROM relationship_properties WHERE relationship_id = ?", 
        [id]
      );
      
      // 删除边
      await db.run("DELETE FROM relationships WHERE id = ?", [id]);
    };

    try {
      // 如果已经在事务中，直接执行操作
      if (this.inTransaction) {
        try {
          await deleteEdgeOperation(this.db);
        } catch (error) {
          if (error instanceof EdgeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to delete edge: ${error}`, error as Error);
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await deleteEdgeOperation(this.db!);
          await this.persistData();
        } catch (error) {
          if (error instanceof EdgeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(`Failed to delete edge: ${error}`, error as Error);
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async getEdges(): Promise<GraphEdge[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 获取所有边基本信息
      const edgesResult = await this.db.query("SELECT * FROM relationships");
      
      if (!edgesResult?.values || edgesResult.values.length === 0) {
        return [];
      }

      const edges: GraphEdge[] = [];
      
      for (const edge of edgesResult.values) {

        // 获取边属性
        const propsResult = await this.db.query(
          "SELECT key, value FROM relationship_properties WHERE relationship_id = ?",
          [edge.id]
        );
        
        if (propsResult?.values && propsResult.values.length > 0) {
          for (const propRow of propsResult.values) {
            try {
              edge.properties![propRow[0]] = JSON.parse(propRow[1]);
            } catch (e) {
              edge.properties![propRow[0]] = propRow[1];
            }
          }
        }

        edges.push(edge);
      }

      return edges;
    } catch (error) {
      throw new DatabaseError(`Failed to get edges: ${error}`, error as Error);
    }
  }

  async findPath(
    startId: string,
    endId: string,
    maxDepth: number = 10
  ): Promise<GraphEdge[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 检查开始和结束节点是否存在
      const startExistsResult = await this.db.query("SELECT 1 FROM nodes WHERE id = ?", [startId]);
      if (!startExistsResult?.values || startExistsResult.values.length === 0) {
        throw new NodeNotFoundError(startId);
      }
      
      const endExistsResult = await this.db.query("SELECT 1 FROM nodes WHERE id = ?", [endId]);
      if (!endExistsResult?.values || endExistsResult.values.length === 0) {
        throw new NodeNotFoundError(endId);
      }

      // 实现广度优先搜索
      const visitedNodes = new Set<string>([startId]);
      const queue: Array<{ nodeId: string; path: string[] }> = [{ nodeId: startId, path: [] }];
      const edgesMap = new Map<string, GraphEdge>();
      
      // 先获取所有边和边的详细信息，以提高性能
      const allEdges = await this.getEdges();
      allEdges.forEach(edge => {
        if (edge.id) {
          edgesMap.set(edge.id, edge);
        }
      });
      
      // 构建快速查找的邻接表
      const adjacencyList = new Map<string, Array<{ edgeId: string; targetId: string }>>();
      
      allEdges.forEach(edge => {
        if (edge.source_id && edge.target_id && edge.id) {
          if (!adjacencyList.has(edge.source_id)) {
            adjacencyList.set(edge.source_id, []);
          }
          adjacencyList.get(edge.source_id)!.push({
            edgeId: edge.id,
            targetId: edge.target_id
          });
        }
      });
      
      // BFS查找路径
      for (let depth = 0; depth < maxDepth && queue.length > 0; depth++) {
        const levelSize = queue.length;
        
        for (let i = 0; i < levelSize; i++) {
          const { nodeId, path } = queue.shift()!;
          
          if (nodeId === endId) {
            // 找到路径，返回边的详细信息
            return path.map(edgeId => edgesMap.get(edgeId))
                       .filter((edge): edge is GraphEdge => edge !== undefined);
          }
          
          // 遍历当前节点的所有出边
          const neighbors = adjacencyList.get(nodeId) || [];
          
          for (const { edgeId, targetId } of neighbors) {
            if (!visitedNodes.has(targetId)) {
              visitedNodes.add(targetId);
              queue.push({
                nodeId: targetId,
                path: [...path, edgeId]
              });
            }
          }
        }
      }
      
      // 没有找到路径
      return [];
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw error;
      }
      throw new DatabaseError(`Failed to find path: ${error}`, error as Error);
    }
  }

  async findConnectedNodes(nodeId: string, depth: number = 1): Promise<GraphNode[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 检查节点是否存在
      const nodeExistsResult = await this.db.query("SELECT 1 FROM nodes WHERE id = ?", [nodeId]);
      if (!nodeExistsResult?.values || nodeExistsResult.values.length === 0) {
        throw new NodeNotFoundError(nodeId);
      }

      // 获取所有节点和边，以优化性能
      const allNodes = await this.getNodes();
      const allEdges = await this.getEdges();
      
      // 构建节点映射和邻接表
      const nodesMap = new Map<string, GraphNode>();
      allNodes.forEach(node => {
        if (node.id) {
          nodesMap.set(node.id, node);
        }
      });
      
      const adjacencyList = new Map<string, string[]>();
      
      // 构建无向图的邻接表
      allEdges.forEach(edge => {
        if (edge.source_id) {
          if (!adjacencyList.has(edge.source_id)) {
            adjacencyList.set(edge.source_id, []);
          }
          if (edge.target_id) {
            adjacencyList.get(edge.source_id)!.push(edge.target_id);
          }
        }
        
        if (edge.target_id) {
          if (!adjacencyList.has(edge.target_id)) {
            adjacencyList.set(edge.target_id, []);
          }
          if (edge.source_id) {
            adjacencyList.get(edge.target_id)!.push(edge.source_id);
          }
        }
      });
      
      // BFS查找连接的节点
      const visitedNodes = new Set<string>([nodeId]);
      const queue: Array<{ id: string; level: number }> = [{ id: nodeId, level: 0 }];
      const connectedNodes: GraphNode[] = [];
      
      while (queue.length > 0) {
        const { id, level } = queue.shift()!;
        
        if (level > 0) { // 不包括起始节点
          const node = nodesMap.get(id);
          if (node) {
            connectedNodes.push(node);
          }
        }
        
        if (level < depth) {
          const neighbors = adjacencyList.get(id) || [];
          
          for (const neighborId of neighbors) {
            if (!visitedNodes.has(neighborId)) {
              visitedNodes.add(neighborId);
              queue.push({ id: neighborId, level: level + 1 });
            }
          }
        }
      }
      
      return connectedNodes;
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw error;
      }
      throw new DatabaseError(`Failed to find connected nodes: ${error}`, error as Error);
    }
  }

  async exportData(): Promise<Uint8Array> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    
    try {
      return this.db.export();
    } catch (error) {
      throw new DatabaseError(`Failed to export data: ${error}`, error as Error);
    }
  }

  async importData(data: Uint8Array): Promise<void> {
    throw new DatabaseError("Import method must be implemented by the platform-specific class");
  }

  async createBackup(): Promise<string> {
    throw new DatabaseError("Backup method must be implemented by the platform-specific class");
  }

  async restoreFromBackup(backupId: string): Promise<void> {
    throw new DatabaseError("Restore method must be implemented by the platform-specific class");
  }

  async listBackups(): Promise<string[]> {
    throw new DatabaseError("List backups method must be implemented by the platform-specific class");
  }
} 