import { v4 as uuidv4 } from "uuid";
import {
  GraphNode,
  GraphEdge,
  GraphDatabaseInterface,
  DatabaseConfig,
  SQLiteEngine,
  DeleteMode,
  Operation,
  ExportOptions,
  ImportMode,
  ImportResult,
  ValidationResult,
} from "./types";
import { DATABASE_SCHEMA } from "./schema";
import {
  DatabaseError,
  NodeNotFoundError,
  EdgeNotFoundError,
  ValidationError,
  TransactionError,
} from "./errors";
// Added imports for new node and relationship types
import {
  GraphNodeType,
  RelayRelationshipType,
} from "../../../models/GraphNode"; // Corrected path

// 新增导入搜索相关类型
import {
  NodeSearchCriteria,
  EdgeSearchCriteria,
  FullTextSearchOptions,
  SearchResult,
  PropertyFilter,
  FilterOperator,
  SortCriteria,
  SortDirection,
} from "../../../models/SearchTypes";

export abstract class BaseGraphDB implements GraphDatabaseInterface {
  protected db: SQLiteEngine | null = null;
  protected config: DatabaseConfig | null = null;
  protected initialized = false;

  // 抽象方法：由具体平台实现
  protected abstract createEngine(
    config: DatabaseConfig
  ): Promise<SQLiteEngine>;
  protected abstract persistData(): Promise<void>;
  protected abstract getEngine(): Promise<SQLiteEngine>;

  async initialize(config: DatabaseConfig): Promise<void> {
    if (this.initialized) return;

    try {
      this.config = config;
      this.db = await this.createEngine(config);
      await this.setupDatabase();
      this.initialized = true;
    } catch (error) {
      console.error("Database initialization error:", error);
      throw error;
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
      throw error;
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
  // TODO: (优化) (AI不要自动执行) 不需要这个变量
  protected get inTransaction(): boolean {
    // 这个需要在具体实现中提供，默认返回false
    return false;
  }

  // 节点操作
  async addNode(
    node: Omit<GraphNode, "created_at" | "updated_at">,
    isTransaction: boolean = true
  ): Promise<string> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const id = node.id || uuidv4();
    const now = new Date().toISOString();

    // 定义添加节点的操作
    const addNodeOperation = async (db: SQLiteEngine) => {
      // 检查标签唯一性以确定 is_independent 的默认值
      let isIndependent =
        node.is_independent !== undefined ? node.is_independent : true; // 默认为 true，除非显式指定

      const existingNodeResult = await db.query(
        "SELECT id FROM nodes WHERE label = ? LIMIT 1",
        [node.label]
      );

      // 如果标签已存在且未显式设置independence，则设为非独立
      if (
        existingNodeResult?.values &&
        existingNodeResult.values.length > 0 &&
        node.is_independent === undefined
      ) {
        isIndependent = false; // 如果标签已存在，则不独立
      }

      // 如果是独立节点，则将所有同名节点更新为非独立
      if (existingNodeResult?.values && existingNodeResult.values.length > 0) {
        await db.run(
          "UPDATE nodes SET is_independent = 0, updated_at = ? WHERE label = ? AND id != ?",
          [now, node.label, id]
        );
      }

      // 插入节点基本信息，包括 is_independent
      await db.run(
        `INSERT INTO nodes (id, type, label, is_independent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`, // 添加 is_independent 的占位符
        [id, node.type, node.label, isIndependent ? 1 : 0, now, now] // 传递 is_independent 的值
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
      if (isTransaction) {
        return await this.db.transaction(async () => {
          try {
            return await addNodeOperation(this.db!);
          } catch (error: any) {
            throw new DatabaseError(`Failed to add node: ${error.message}`);
          }
        });
      } else {
        return await addNodeOperation(this.db!);
      }
    } catch (error) {
      throw error;
    }
  }
  async updateNode(
    id: string,
    updates: Partial<GraphNode>,
    isTransaction: boolean = true
  ): Promise<void> {
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
        (updates as any).label !== undefined ||
        updates.type !== undefined ||
        updates.is_independent !== undefined // Also check if is_independent is explicitly provided
      ) {
        const sets: string[] = [];
        const params: any[] = [];
        let isIndependent = updates.is_independent; // Start with explicitly provided value

        if (updates.label !== undefined) {
          sets.push("label = ?");
          params.push((updates as any).label);

          // 如果修改了标签，需要检查这个新标签是否已存在于其他同名节点
          if (isIndependent === undefined) {
            const existingNodeResult = await db.query(
              "SELECT id FROM nodes WHERE label = ? AND id != ? LIMIT 1",
              [updates.label, id] // Exclude the current node being updated
            );
            isIndependent = !(
              existingNodeResult?.values && existingNodeResult.values.length > 0
            );

            // 如果当前节点变为独立节点，查找所有同名节点并更新它们为非独立
            if (isIndependent) {
              // 找出当前节点的标签
              const currentNodeLabel = updates.label;

              // 更新所有与新标签同名的其他节点为非独立
              if (currentNodeLabel) {
                await db.run(
                  "UPDATE nodes SET is_independent = 0, updated_at = ? WHERE label = ? AND id != ?",
                  [new Date().toISOString(), currentNodeLabel, id]
                );
              }
            }
          }
        }
        if (updates.type !== undefined) {
          sets.push("type = ?");
          params.push(updates.type);
        }
        // Only set is_independent if it was explicitly provided or recalculated
        if (isIndependent !== undefined) {
          sets.push("is_independent = ?");
          params.push(isIndependent ? 1 : 0);
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
      if (!isTransaction) {
        try {
          await updateOperation(this.db);
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to update node: ${error}`,
            error as Error
          );
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await updateOperation(this.db!);
          // 移除persistData调用，因为它已经在事务API中自动执行了
        } catch (error) {
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to update node: ${error}`,
            error as Error
          );
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async deleteNode(
    id: string,
    mode: DeleteMode = DeleteMode.KEEP_CONNECTED,
    isTransaction = true
  ): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const deleteOperation = async (db: SQLiteEngine) => {
      let nodeToDelete: GraphNode;
      try {
        nodeToDelete = await this.getNode(id); // Fetch node details including type
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          // getNode throws generic Error
          throw new NodeNotFoundError(id);
        }
        throw error; // Re-throw other errors
      }

      // Case 1: Deleting a RELATIONSHIP_TYPE node
      if (nodeToDelete.type === GraphNodeType.RELATIONSHIP_TYPE) {
        // Regardless of mode, a RELATIONSHIP_TYPE node and its _relay edges are fully deleted.
        // This is because a RELATIONSHIP_TYPE node represents the relationship itself.

        // a. Find and delete incoming _relay edge
        const incomingRelayResult = await db.query(
          `SELECT id FROM relationships WHERE target_id = ? AND type = ?`,
          [id, RelayRelationshipType.RELAY]
        );
        if (
          incomingRelayResult?.values &&
          incomingRelayResult.values.length > 0
        ) {
          const incomingRelayId = incomingRelayResult.values[0].id;
          await db.run(
            "DELETE FROM relationship_properties WHERE relationship_id = ?",
            [incomingRelayId]
          );
          await db.run("DELETE FROM relationships WHERE id = ?", [
            incomingRelayId,
          ]);
        }

        // b. Find and delete outgoing _relay edge
        const outgoingRelayResult = await db.query(
          `SELECT id FROM relationships WHERE source_id = ? AND type = ?`,
          [id, RelayRelationshipType.RELAY]
        );
        if (
          outgoingRelayResult?.values &&
          outgoingRelayResult.values.length > 0
        ) {
          const outgoingRelayId = outgoingRelayResult.values[0].id;
          await db.run(
            "DELETE FROM relationship_properties WHERE relationship_id = ?",
            [outgoingRelayId]
          );
          await db.run("DELETE FROM relationships WHERE id = ?", [
            outgoingRelayId,
          ]);
        }

        // c. Delete RELATIONSHIP_TYPE node's properties
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
        // d. Delete RELATIONSHIP_TYPE node itself
        await db.run("DELETE FROM nodes WHERE id = ?", [id]);
        return; //RELATIONSHIP_TYPE node deletion is complete
      }

      // Case 2: Deleting a regular node
      if (mode === DeleteMode.CASCADE) {
        // CASCADE mode for regular nodes

        // a. Handle outgoing structured relationships
        const outgoingRelays = await db.query(
          `SELECT target_id FROM relationships WHERE source_id = ? AND type = ?`,
          [id, RelayRelationshipType.RELAY]
        );
        if (outgoingRelays?.values) {
          for (const relay of outgoingRelays.values) {
            const relNodeId = relay.target_id;
            try {
              const relNode = await this.getNode(relNodeId);
              if (relNode.type === GraphNodeType.RELATIONSHIP_TYPE) {
                // Recursively delete the RELATIONSHIP_TYPE node. This will handle its _relay edges.
                // Pass the db instance to ensure it's part of the same transaction.
                await this.deleteNodeInternal(
                  relNodeId,
                  DeleteMode.CASCADE,
                  db
                );
              }
            } catch (e) {
              /* relNode not found or other issue, ignore */
            }
          }
        }

        // b. Handle incoming structured relationships
        const incomingRelays = await db.query(
          `SELECT source_id FROM relationships WHERE target_id = ? AND type = ?`,
          [id, RelayRelationshipType.RELAY]
        );
        if (incomingRelays?.values) {
          for (const relay of incomingRelays.values) {
            const relNodeId = relay.source_id;
            try {
              const relNode = await this.getNode(relNodeId);
              if (relNode.type === GraphNodeType.RELATIONSHIP_TYPE) {
                await this.deleteNodeInternal(
                  relNodeId,
                  DeleteMode.CASCADE,
                  db
                );
              }
            } catch (e) {
              /* relNode not found or other issue, ignore */
            }
          }
        }

        // c. Standard CASCADE: Delete direct edges and their properties
        const relatedDirectEdgesResult = await db.query(
          `SELECT id FROM relationships WHERE (source_id = ? OR target_id = ?) AND type != ?`,
          [id, id, RelayRelationshipType.RELAY] // Exclude already handled _relay edges
        );
        if (relatedDirectEdgesResult?.values) {
          for (const edgeRow of relatedDirectEdgesResult.values) {
            await db.run(
              "DELETE FROM relationship_properties WHERE relationship_id = ?",
              [edgeRow.id]
            );
            await db.run("DELETE FROM relationships WHERE id = ?", [
              edgeRow.id,
            ]);
          }
        }

        // d. Delete node's properties
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
        // e. Delete node itself
        await db.run("DELETE FROM nodes WHERE id = ?", [id]);
      } else {
        // KEEP_CONNECTED mode for regular nodes
        // Standard KEEP_CONNECTED: only delete node and its properties, nullify connections
        await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
        await db.run(
          "UPDATE relationships SET source_id = NULL WHERE source_id = ?",
          [id]
        );
        await db.run(
          "UPDATE relationships SET target_id = NULL WHERE target_id = ?",
          [id]
        );
        await db.run("DELETE FROM nodes WHERE id = ?", [id]);
      }
    };

    try {
      if (isTransaction) {
        await this.db.transaction(async () => {
          // Pass this.db! which is the transactional db instance
          await deleteOperation(this.db!);
        });
      } else {
        await deleteOperation(this.db!);
      }
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to delete node: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Helper method for recursive deletion within a transaction
  private async deleteNodeInternal(
    id: string,
    mode: DeleteMode,
    db: SQLiteEngine
  ): Promise<void> {
    // This is a simplified version for internal calls, assuming db is already provided (transactional)
    // Replicates the logic of the main deleteNode but uses the passed 'db' and avoids starting a new transaction

    let nodeToDelete: GraphNode;
    try {
      // Note: this.getNode uses this.db, which might not be the transactional 'db' if getNode isn't refactored.
      // For safety, direct query or pass 'db' to getNode if possible.
      // Assuming getNode can work correctly in this context for now.
      const nodeRow = await db.query(
        "SELECT id, type FROM nodes WHERE id = ? LIMIT 1",
        [id]
      );
      if (!nodeRow?.values || nodeRow.values.length === 0) {
        throw new NodeNotFoundError(id);
      }
      nodeToDelete = {
        id: nodeRow.values[0].id,
        type: nodeRow.values[0].type,
        label: "",
        properties: {},
      }; // Minimal GraphNode
    } catch (error) {
      if (error instanceof NodeNotFoundError) throw error;
      throw new DatabaseError(
        `Error fetching node ${id} in deleteNodeInternal: ${error}`
      );
    }

    if (nodeToDelete.type === GraphNodeType.RELATIONSHIP_TYPE) {
      const incomingRelayResult = await db.query(
        `SELECT id FROM relationships WHERE target_id = ? AND type = ?`,
        [id, RelayRelationshipType.RELAY]
      );
      if (
        incomingRelayResult?.values &&
        incomingRelayResult.values.length > 0
      ) {
        const incomingRelayId = incomingRelayResult.values[0].id;
        await db.run(
          "DELETE FROM relationship_properties WHERE relationship_id = ?",
          [incomingRelayId]
        );
        await db.run("DELETE FROM relationships WHERE id = ?", [
          incomingRelayId,
        ]);
      }
      const outgoingRelayResult = await db.query(
        `SELECT id FROM relationships WHERE source_id = ? AND type = ?`,
        [id, RelayRelationshipType.RELAY]
      );
      if (
        outgoingRelayResult?.values &&
        outgoingRelayResult.values.length > 0
      ) {
        const outgoingRelayId = outgoingRelayResult.values[0].id;
        await db.run(
          "DELETE FROM relationship_properties WHERE relationship_id = ?",
          [outgoingRelayId]
        );
        await db.run("DELETE FROM relationships WHERE id = ?", [
          outgoingRelayId,
        ]);
      }
      await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
      await db.run("DELETE FROM nodes WHERE id = ?", [id]);
      return;
    }

    // For regular nodes in CASCADE (this internal helper is primarily for cascading RELATIONSHIP_TYPE deletion)
    if (mode === DeleteMode.CASCADE) {
      // Outgoing structured
      const outgoingRelays = await db.query(
        `SELECT target_id FROM relationships WHERE source_id = ? AND type = ?`,
        [id, RelayRelationshipType.RELAY]
      );
      if (outgoingRelays?.values) {
        for (const relay of outgoingRelays.values) {
          // Check if target is RELATIONSHIP_TYPE before recursive call
          const relNodeRow = await db.query(
            "SELECT type FROM nodes WHERE id = ? LIMIT 1",
            [relay.target_id]
          );
          if (
            relNodeRow?.values &&
            relNodeRow.values[0].type === GraphNodeType.RELATIONSHIP_TYPE
          ) {
            await this.deleteNodeInternal(
              relay.target_id,
              DeleteMode.CASCADE,
              db
            );
          }
        }
      }
      // Incoming structured
      const incomingRelays = await db.query(
        `SELECT source_id FROM relationships WHERE target_id = ? AND type = ?`,
        [id, RelayRelationshipType.RELAY]
      );
      if (incomingRelays?.values) {
        for (const relay of incomingRelays.values) {
          const relNodeRow = await db.query(
            "SELECT type FROM nodes WHERE id = ? LIMIT 1",
            [relay.source_id]
          );
          if (
            relNodeRow?.values &&
            relNodeRow.values[0].type === GraphNodeType.RELATIONSHIP_TYPE
          ) {
            await this.deleteNodeInternal(
              relay.source_id,
              DeleteMode.CASCADE,
              db
            );
          }
        }
      }
      // Standard cascade for direct edges
      const relatedDirectEdgesResult = await db.query(
        `SELECT id FROM relationships WHERE (source_id = ? OR target_id = ?) AND type != ?`,
        [id, id, RelayRelationshipType.RELAY]
      );
      if (relatedDirectEdgesResult?.values) {
        for (const edgeRow of relatedDirectEdgesResult.values) {
          await db.run(
            "DELETE FROM relationship_properties WHERE relationship_id = ?",
            [edgeRow.id]
          );
        }
        // Batch delete relationships after properties
        await db.run(
          "DELETE FROM relationships WHERE (source_id = ? OR target_id = ?) AND type != ?",
          [id, id, RelayRelationshipType.RELAY]
        );
      }
      await db.run("DELETE FROM node_properties WHERE node_id = ?", [id]);
      await db.run("DELETE FROM nodes WHERE id = ?", [id]);
    }
    // KEEP_CONNECTED for regular nodes is handled by the main deleteOperation
  }

  async getNodes(): Promise<GraphNode[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 获取所有节点基本信息
      const nodesResult = await this.db.query(
        "SELECT *, is_independent FROM nodes"
      );

      if (!nodesResult?.values || nodesResult.values.length === 0) {
        return [];
      }

      const nodes: GraphNode[] = [];

      for (const nodeRow of nodesResult.values) {
        // 确保初始化节点属性对象
        const node: GraphNode = {
          id: nodeRow.id,
          label: nodeRow.label,
          type: nodeRow.type || "node", // 确保有type字段
          is_independent: nodeRow.is_independent === 1, // Convert 0/1 to boolean
          created_at: nodeRow.created_at,
          updated_at: nodeRow.updated_at,
          properties: {}, // 确保一定有properties对象
        };

        // 获取节点属性
        const propsResult = await this.db.query(
          "SELECT key, value FROM node_properties WHERE node_id = ?",
          [node.id]
        );

        if (propsResult?.values && propsResult.values.length > 0) {
          for (const propRow of propsResult.values) {
            let key: string;
            let rawValue: string;

            if (Array.isArray(propRow)) {
              // 如果是数组形式 [key, value]
              key = propRow[0];
              rawValue = propRow[1];
            } else {
              // 如果是对象形式 {key, value}
              key = propRow.key;
              rawValue = propRow.value;
            }

            try {
              node.properties![key] = JSON.parse(rawValue);
            } catch (e) {
              node.properties![key] = rawValue;
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
  async addEdge(
    edge: Omit<GraphEdge, "created_at">,
    isTransaction = true
  ): Promise<string> {
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

        if (
          !sourceExistsResult?.values ||
          sourceExistsResult.values.length === 0
        ) {
          throw new NodeNotFoundError(edge.source_id);
        }
      }

      if (edge.target_id) {
        const targetExistsResult = await db.query(
          "SELECT 1 FROM nodes WHERE id = ?",
          [edge.target_id]
        );

        if (
          !targetExistsResult?.values ||
          targetExistsResult.values.length === 0
        ) {
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
      // 直接执行操作
      if (!isTransaction) {
        try {
          return await addEdgeOperation(this.db);
        } catch (error) {
          console.error("Error in addEdge operation:", error);
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to add edge: ${error}`,
            error as Error
          );
        }
      }

      // 否则，使用事务执行操作
      return await this.db.transaction(async () => {
        try {
          const result = await addEdgeOperation(this.db!);
          // 不需要调用persistData，因为withTransaction会自动处理
          return result;
        } catch (error) {
          console.error("Error in addEdge transaction:", error);
          if (error instanceof NodeNotFoundError) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to add edge: ${error}`,
            error as Error
          );
        }
      });
    } catch (error) {
      console.error("Fatal error in addEdge:", error);
      throw error;
    }
  }

  async updateEdge(
    id: string,
    updates: Partial<GraphEdge>,
    isTransaction = true
  ): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const updateEdgeOperation = async (db: SQLiteEngine): Promise<void> => {
      // 新增：判断 id 是否为结构化关系（RELATIONSHIP_TYPE 节点）
      const relNodeResult = await db.query(
        "SELECT * FROM nodes WHERE id = ? AND type = ?",
        [id, GraphNodeType.RELATIONSHIP_TYPE]
      );
      if (relNodeResult.values && relNodeResult.values.length > 0) {
        const nodeUpdates: Partial<GraphNode> = {};

        // 更新中心节点
        if (updates.type !== undefined) nodeUpdates.label = updates.type;
        if (updates.properties !== undefined)
          nodeUpdates.properties = updates.properties;
        if (Object.keys(nodeUpdates).length !== 0) {
          // 直接调用 updateNode
          await this.updateNode(id, nodeUpdates, false);
        }

        let relayEdgeIds = (await this.getEdge(id)).structuredMeta
          ?.relayEdgeIds;

        if (!relayEdgeIds) {
          throw new Error("Structured relationship error");
        }

        // 更新关联节点
        if (updates.source_id !== undefined) {
          await this.updateEdge(
            relayEdgeIds[0],
            { source_id: updates.source_id },
            false
          );
        }
        if (updates.target_id !== undefined) {
          await this.updateEdge(
            relayEdgeIds[1],
            { target_id: updates.target_id },
            false
          );
        }
        return;
      }

      // 原有逻辑：更新普通边
      // 创建更新边的操作
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

          if (
            !sourceExistsResult?.values ||
            sourceExistsResult.values.length === 0
          ) {
            throw new NodeNotFoundError(updates.source_id);
          }
        }

        if (updates.target_id) {
          const targetExistsResult = await db.query(
            "SELECT 1 FROM nodes WHERE id = ?",
            [updates.target_id]
          );

          if (
            !targetExistsResult?.values ||
            targetExistsResult.values.length === 0
          ) {
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
      // 直接执行操作
      if (!isTransaction) {
        try {
          await updateEdgeOperation(this.db);
        } catch (error) {
          if (
            error instanceof NodeNotFoundError ||
            error instanceof EdgeNotFoundError
          ) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to update edge: ${error}`,
            error as Error
          );
        }
        return;
      }

      // 否则，使用事务执行操作
      await this.db.transaction(async () => {
        try {
          await updateEdgeOperation(this.db!);
          // 移除persistData调用，因为它已经在事务API中自动执行了
        } catch (error) {
          if (
            error instanceof NodeNotFoundError ||
            error instanceof EdgeNotFoundError
          ) {
            throw error;
          }
          throw new DatabaseError(
            `Failed to update edge: ${error}`,
            error as Error
          );
        }
      });
    } catch (error) {
      throw error;
    }
  }

  async deleteEdge(id: string, isTransaction = true): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // 新增：判断 id 是否为结构化关系（RELATIONSHIP_TYPE 节点）
    const db = this.db;
    const relNodeResult = await db.query(
      "SELECT * FROM nodes WHERE id = ? AND type = ?",
      [id, GraphNodeType.RELATIONSHIP_TYPE]
    );
    if (relNodeResult.values && relNodeResult.values.length > 0) {
      // 结构化关系，直接调用 deleteNode
      await this.deleteNode(id, DeleteMode.CASCADE, isTransaction);
      return;
    }

    // 原有逻辑：删除普通边
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
      // 使用事务执行删除操作
      if (isTransaction) {
        await this.db.transaction(async () => {
          try {
            await deleteEdgeOperation(this.db!);
          } catch (error) {
            if (error instanceof EdgeNotFoundError) {
              throw error;
            }
            throw new DatabaseError(
              `Failed to delete edge: ${error}`,
              error as Error
            );
          }
        });
      } else {
        await deleteEdgeOperation(this.db!);
      }
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

      // 先构建所有边的映射，便于后续查找
      const allEdges: any[] = edgesResult.values;
      const edgeMap = new Map<string, any>();
      for (const edgeRow of allEdges) {
        edgeMap.set(edgeRow.id, edgeRow);
      }

      // 记录已处理的结构化关系节点ID和边ID，避免重复
      const processedRelNodeIds = new Set<string>();
      const processedEdgeIds = new Set<string>();
      const resultEdges: GraphEdge[] = [];

      // 1. 先处理所有结构化关系（RELATIONSHIP_TYPE节点 + 两条_relay边）
      // 获取所有类型节点
      const relNodesResult = await this.db.query(
        "SELECT * FROM nodes WHERE type = ?",
        [GraphNodeType.RELATIONSHIP_TYPE]
      );
      const relNodes = relNodesResult?.values || [];
      for (const relNode of relNodes) {
        // 查找与该类型节点相关的两条_relay边
        const relayEdgesResult = await this.db.query(
          `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?) AND type = ?`,
          [relNode.id, relNode.id, RelayRelationshipType.RELAY]
        );
        const relayEdges = relayEdgesResult?.values || [];
        if (relayEdges.length !== 2) continue; // 必须恰好两条_relay边
        // 判断方向
        let sourceId = "",
          targetId = "";
        let relayEdgeIds: [string, string] = [
          relayEdges[0].id,
          relayEdges[1].id,
        ];
        for (const edge of relayEdges) {
          if (edge.source_id === relNode.id) {
            targetId = edge.target_id;
          } else if (edge.target_id === relNode.id) {
            sourceId = edge.source_id;
          }
        }
        // 组装抽象边
        resultEdges.push({
          id: relNode.id,
          source_id: sourceId,
          target_id: targetId,
          type: relNode.label || "",
          created_at: relNode.created_at,
          properties: relNode.properties || {},
          isStructured: true,
          structuredMeta: {
            relationshipNodeId: relNode.id,
            relayEdgeIds,
            label: relNode.label || "",
            properties: relNode.properties || {},
          },
        });
        processedRelNodeIds.add(relNode.id);
        relayEdges.forEach((e) => processedEdgeIds.add(e.id));
      }

      // 2. 处理普通边（非_relay边，且未被结构化关系覆盖）
      for (const edgeRow of allEdges) {
        if (processedEdgeIds.has(edgeRow.id)) continue; // 跳过已被结构化关系覆盖的边
        if (edgeRow.type === RelayRelationshipType.RELAY) continue; // 跳过_relay边
        // 获取属性
        const propsResult = await this.db.query(
          "SELECT key, value FROM relationship_properties WHERE relationship_id = ?",
          [edgeRow.id]
        );
        const properties: Record<string, any> = {};
        if (propsResult?.values && propsResult.values.length > 0) {
          for (const propRow of propsResult.values) {
            let key: string;
            let rawValue: string;
            if (Array.isArray(propRow)) {
              key = propRow[0];
              rawValue = propRow[1];
            } else {
              key = propRow.key;
              rawValue = propRow.value;
            }
            try {
              properties[key] = JSON.parse(rawValue);
            } catch (e) {
              properties[key] = rawValue;
            }
          }
        }
        resultEdges.push({
          id: edgeRow.id,
          source_id: edgeRow.source_id,
          target_id: edgeRow.target_id,
          type: edgeRow.type,
          created_at: edgeRow.created_at,
          properties,
          isStructured: false,
        });
      }
      return resultEdges;
    } catch (error) {
      console.error("Error in getEdges:", error);
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
      const startExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [startId]
      );
      if (!startExistsResult?.values || startExistsResult.values.length === 0) {
        throw new NodeNotFoundError(startId);
      }

      const endExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [endId]
      );
      if (!endExistsResult?.values || endExistsResult.values.length === 0) {
        throw new NodeNotFoundError(endId);
      }

      // 实现广度优先搜索
      const visitedNodes = new Set<string>([startId]);
      const queue: Array<{ nodeId: string; path: string[] }> = [
        { nodeId: startId, path: [] },
      ];
      const edgesMap = new Map<string, GraphEdge>();

      // 先获取所有边和边的详细信息，以提高性能
      const allEdges = await this.getEdges();
      allEdges.forEach((edge) => {
        if (edge.id) {
          edgesMap.set(edge.id, edge);
        }
      });

      // 构建快速查找的邻接表
      const adjacencyList = new Map<
        string,
        Array<{ edgeId: string; targetId: string }>
      >();

      allEdges.forEach((edge) => {
        if (edge.source_id && edge.target_id && edge.id) {
          if (!adjacencyList.has(edge.source_id)) {
            adjacencyList.set(edge.source_id, []);
          }
          adjacencyList.get(edge.source_id)!.push({
            edgeId: edge.id,
            targetId: edge.target_id,
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
            return path
              .map((edgeId) => edgesMap.get(edgeId))
              .filter((edge): edge is GraphEdge => edge !== undefined);
          }

          // 遍历当前节点的所有出边
          const neighbors = adjacencyList.get(nodeId) || [];

          for (const { edgeId, targetId } of neighbors) {
            if (!visitedNodes.has(targetId)) {
              visitedNodes.add(targetId);
              queue.push({
                nodeId: targetId,
                path: [...path, edgeId],
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

  async findConnectedNodes(
    nodeId: string,
    depth: number = 1
  ): Promise<GraphNode[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 检查节点是否存在
      const nodeExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [nodeId]
      );
      if (!nodeExistsResult?.values || nodeExistsResult.values.length === 0) {
        throw new NodeNotFoundError(nodeId);
      }

      // 获取所有节点和边，以优化性能
      const allNodes = await this.getNodes();
      const allEdges = await this.getEdges();

      // 构建节点映射和邻接表
      const nodesMap = new Map<string, GraphNode>();
      allNodes.forEach((node) => {
        if (node.id) {
          nodesMap.set(node.id, node);
        }
      });

      const adjacencyList = new Map<string, string[]>();

      // 构建无向图的邻接表
      allEdges.forEach((edge) => {
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
      const queue: Array<{ id: string; level: number }> = [
        { id: nodeId, level: 0 },
      ];
      const connectedNodes: GraphNode[] = [];

      while (queue.length > 0) {
        const { id, level } = queue.shift()!;

        if (level > 0) {
          // 不包括起始节点
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
      throw new DatabaseError(
        `Failed to find connected nodes: ${error}`,
        error as Error
      );
    }
  }

  async exportData(): Promise<Uint8Array> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      return this.db.export();
    } catch (error) {
      throw new DatabaseError(
        `Failed to export data: ${error}`,
        error as Error
      );
    }
  }

  async importData(data: Uint8Array): Promise<void> {
    throw new DatabaseError(
      "Import method must be implemented by the platform-specific class"
    );
  }

  async createBackup(): Promise<string> {
    throw new DatabaseError(
      "Backup method must be implemented by the platform-specific class"
    );
  }

  async restoreFromBackup(backupId: string): Promise<void> {
    throw new DatabaseError(
      "Restore method must be implemented by the platform-specific class"
    );
  }

  async listBackups(): Promise<string[]> {
    throw new DatabaseError(
      "List backups method must be implemented by the platform-specific class"
    );
  }

  // 清空数据库方法
  public async clear(): Promise<void> {
    const db = this.db;
    if (!db) throw new DatabaseError("Database not initialized");
    try {
      await db.beginTransaction();

      // 先清空边属性表
      await db.run("DELETE FROM relationship_properties");

      // 再清空边表
      await db.run("DELETE FROM relationships");

      // 清空节点属性表
      await db.run("DELETE FROM node_properties");

      // 最后清空节点表
      await db.run("DELETE FROM nodes");

      await db.commitTransaction();
    } catch (error) {
      await db.rollbackTransaction();
      throw error;
    }
  }

  // 导出数据为JSON
  public async exportToJson(options?: ExportOptions): Promise<string> {
    const prettyPrint = options?.prettyPrint ?? true;
    const includeMetadata = options?.includeMetadata ?? true;

    // 获取所有节点和边
    const nodes = await this.getNodes();
    const edges = await this.getEdges();

    // 构建导出数据
    const exportData: any = {
      data: {
        nodes,
        edges,
      },
    };

    // 添加元数据
    if (includeMetadata) {
      exportData.metadata = {
        version: "1.0",
        created_at: new Date().toISOString(),
      };
    }

    // 转换为JSON字符串
    return JSON.stringify(exportData, null, prettyPrint ? 2 : undefined);
  }

  // 验证导入数据
  public async validateImportData(jsonData: string): Promise<ValidationResult> {
    try {
      // 解析JSON数据
      const parsedData = JSON.parse(jsonData);

      // 检查基本结构
      if (
        !parsedData.data ||
        !Array.isArray(parsedData.data.nodes) ||
        !Array.isArray(parsedData.data.edges)
      ) {
        return {
          valid: false,
          nodeCount: 0,
          edgeCount: 0,
          errors: [
            "Invalid data structure: missing 'data.nodes' or 'data.edges' arrays",
          ],
        };
      }

      // 提取版本信息
      const version = parsedData.metadata?.version;

      // 计算节点和边的数量
      const nodeCount = parsedData.data.nodes.length;
      const edgeCount = parsedData.data.edges.length;

      // 验证节点数据
      const nodeErrors: string[] = [];
      parsedData.data.nodes.forEach((node: any, index: number) => {
        if (!node.type || !node.label) {
          nodeErrors.push(
            `Node at index ${index} is missing required fields (type or label)`
          );
        }
      });

      // 验证边数据
      const edgeErrors: string[] = [];
      parsedData.data.edges.forEach((edge: any, index: number) => {
        if (!edge.source_id || !edge.target_id || !edge.type) {
          edgeErrors.push(
            `Edge at index ${index} is missing required fields (source_id, target_id, or type)`
          );
        }
      });

      const errors = [...nodeErrors, ...edgeErrors];

      return {
        valid: errors.length === 0,
        version,
        nodeCount,
        edgeCount,
        errors,
      };
    } catch (error) {
      return {
        valid: false,
        nodeCount: 0,
        edgeCount: 0,
        errors: [`Invalid JSON format: ${(error as Error).message}`],
      };
    }
  }

  // 获取单个边的方法
  public async getEdge(id: string): Promise<GraphEdge> {
    const db = this.db;
    if (!db) throw new DatabaseError("Database not initialized");

    // 先查找 id 是否为 RELATIONSHIP_TYPE 节点
    const relNodeResult = await db.query(
      "SELECT * FROM nodes WHERE id = ? AND type = ?",
      [id, GraphNodeType.RELATIONSHIP_TYPE]
    );
    if (relNodeResult.values && relNodeResult.values.length > 0) {
      const relNode = relNodeResult.values[0];
      // 查找与该类型节点相关的两条 _relay 边
      const relayEdgesResult = await db.query(
        `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?) AND type = ?`,
        [id, id, RelayRelationshipType.RELAY]
      );
      const relayEdges = relayEdgesResult?.values || [];
      if (relayEdges.length === 2) {
        let sourceId = "",
          targetId = "";
        let relayEdgeIds: [string, string] = [
          relayEdges[0].id,
          relayEdges[1].id,
        ];
        for (const edge of relayEdges) {
          if (edge.source_id === id) {
            targetId = edge.target_id;
          } else if (edge.target_id === id) {
            sourceId = edge.source_id;
          }
        }
        if (
          typeof sourceId === "string" &&
          typeof targetId === "string" &&
          typeof relNode.id === "string" &&
          typeof relayEdgeIds[0] === "string" &&
          typeof relayEdgeIds[1] === "string"
        ) {
          // 组装结构化边
          return {
            id: relNode.id,
            source_id: sourceId,
            target_id: targetId,
            type: relNode.label || "",
            created_at: relNode.created_at,
            properties: relNode.properties || {},
            isStructured: true,
            structuredMeta: {
              relationshipNodeId: relNode.id,
              relayEdgeIds,
              label: relNode.label || "",
              properties: relNode.properties || {},
            },
          };
        }
      }
      throw new EdgeNotFoundError(id); // 结构不完整视为找不到
    }

    // 否则按普通边处理
    const result = await db.query("SELECT * FROM relationships WHERE id = ?", [
      id,
    ]);
    if (!result.values || result.values.length === 0) {
      throw new EdgeNotFoundError(id);
    }
    // 获取基本边信息
    const edge: GraphEdge = result.values[0] as GraphEdge;
    // 获取边的属性
    const propsResult = await db.query(
      "SELECT key, value FROM relationship_properties WHERE relationship_id = ?",
      [id]
    );
    edge.properties = {};
    if (propsResult?.values && propsResult.values.length > 0) {
      for (const propRow of propsResult.values) {
        let key: string;
        let rawValue: string;
        if (Array.isArray(propRow)) {
          key = propRow[0];
          rawValue = propRow[1];
        } else {
          key = propRow.key;
          rawValue = propRow.value;
        }
        try {
          edge.properties[key] = JSON.parse(rawValue);
        } catch (e) {
          edge.properties[key] = rawValue;
        }
      }
    }
    edge.isStructured = false;
    return edge;
  }

  // 从JSON导入数据方法中修改边导入部分
  public async importFromJson(
    jsonData: string,
    mode: ImportMode
  ): Promise<ImportResult> {
    // 解析JSON数据
    let parsedData;
    try {
      parsedData = JSON.parse(jsonData);
    } catch (error) {
      return {
        success: false,
        nodesImported: 0,
        edgesImported: 0,
        errors: [`Invalid JSON format: ${(error as Error).message}`],
      };
    }

    // 验证数据结构
    if (
      !parsedData.data ||
      !Array.isArray(parsedData.data.nodes) ||
      !Array.isArray(parsedData.data.edges)
    ) {
      return {
        success: false,
        nodesImported: 0,
        edgesImported: 0,
        errors: [
          "Invalid data structure: missing 'data.nodes' or 'data.edges' arrays",
        ],
      };
    }

    const db = this.db;
    if (!db) throw new DatabaseError("Database not initialized");
    const errors: string[] = [];
    const importedNodeIds: string[] = [];

    try {
      await db.beginTransaction();

      // 如果是替换模式，先清空数据库
      if (mode === ImportMode.REPLACE) {
        // 清空边表
        await db.run("DELETE FROM relationship_properties");
        await db.run("DELETE FROM relationships");
        // 清空节点表
        await db.run("DELETE FROM node_properties");
        await db.run("DELETE FROM nodes");
      }

      // 导入节点
      for (const node of parsedData.data.nodes) {
        try {
          // 处理ID冲突
          if (mode === ImportMode.MERGE && node.id) {
            // 检查节点是否已存在
            try {
              await this.getNode(node.id);
              // 如果存在则更新
              await this.updateNode(node.id, {
                label: node.label,
                type: node.type,
                properties: node.properties,
              });
              importedNodeIds.push(node.id);
            } catch {
              // 不存在则添加
              const newId = await this.addNode({
                id: node.id,
                label: node.label,
                type: node.type,
                properties: node.properties,
              });
              importedNodeIds.push(newId);
            }
          } else {
            // 替换模式或无ID的合并模式直接添加
            const newNode = {
              id: node.id, // 如果提供了ID则使用，否则会自动生成
              label: node.label,
              type: node.type,
              properties: node.properties,
            };
            const newId = await this.addNode(newNode);
            importedNodeIds.push(newId);
          }
        } catch (error) {
          errors.push(
            `Failed to import node ${node.id || "unknown"}: ${
              (error as Error).message
            }`
          );
        }
      }

      // 导入边 - 修改这部分添加外键约束检查
      const importedEdgeIds: string[] = [];

      // 创建一个已导入节点ID的集合，用于快速查找
      const importedNodesSet = new Set(importedNodeIds);

      // 检查所有需要导入的边，确保引用的节点都存在
      for (const edge of parsedData.data.edges) {
        try {
          // 检查源节点和目标节点是否存在
          const sourceExists = edge.source_id
            ? importedNodesSet.has(edge.source_id)
            : true;
          const targetExists = edge.target_id
            ? importedNodesSet.has(edge.target_id)
            : true;

          if (!sourceExists) {
            errors.push(
              `Failed to import edge ${edge.id || "unknown"}: Source node ${
                edge.source_id
              } does not exist`
            );
            continue;
          }

          if (!targetExists) {
            errors.push(
              `Failed to import edge ${edge.id || "unknown"}: Target node ${
                edge.target_id
              } does not exist`
            );
            continue;
          }

          // 处理ID冲突
          if (mode === ImportMode.MERGE && edge.id) {
            // 检查边是否已存在
            try {
              await this.getEdge(edge.id);
              // 如果存在则更新
              await this.updateEdge(edge.id, {
                source_id: edge.source_id,
                target_id: edge.target_id,
                type: edge.type,
                properties: edge.properties,
              });
              importedEdgeIds.push(edge.id);
            } catch {
              // 不存在则添加
              const newId = await this.addEdge({
                id: edge.id,
                source_id: edge.source_id,
                target_id: edge.target_id,
                type: edge.type,
                properties: edge.properties,
              });
              importedEdgeIds.push(newId);
            }
          } else {
            // 替换模式或无ID的合并模式直接添加
            const newEdge = {
              id: edge.id, // 如果提供了ID则使用，否则会自动生成
              source_id: edge.source_id,
              target_id: edge.target_id,
              type: edge.type,
              properties: edge.properties,
            };

            const newId = await this.addEdge(newEdge);
            importedEdgeIds.push(newId);
          }
        } catch (error) {
          errors.push(
            `Failed to import edge ${edge.id || "unknown"}: ${
              (error as Error).message
            }`
          );
        }
      }

      await db.commitTransaction();

      return {
        success: errors.length === 0,
        nodesImported: importedNodeIds.length,
        edgesImported: importedEdgeIds.length,
        errors,
      };
    } catch (error) {
      await db.rollbackTransaction();
      return {
        success: false,
        nodesImported: 0,
        edgesImported: 0,
        errors: [`Transaction failed: ${(error as Error).message}`],
      };
    }
  }

  // 获取单个节点的方法
  public async getNode(id: string): Promise<GraphNode> {
    const db = this.db;
    if (!db) throw new DatabaseError("Database not initialized");
    const result = await db.query(
      "SELECT *, is_independent FROM nodes WHERE id = ?",
      [id]
    );

    if (!result.values || result.values.length === 0) {
      throw new Error(`Node with id ${id} not found`);
    }

    const nodeRow = result.values[0];
    const properties = await this._getNodeProperties(id);

    return {
      ...nodeRow,
      is_independent: nodeRow.is_independent === 1,
      properties: properties,
    } as GraphNode;
  }

  // 搜索节点
  async searchNodes(
    criteria: NodeSearchCriteria,
    isTransaction = true
  ): Promise<{ nodes: GraphNode[]; totalCount: number }> {
    const searchNodesOperation = async () => {
      // 构建基本查询
      let query = `
          SELECT n.id, n.type, n.label, n.is_independent, n.created_at, n.updated_at -- Select is_independent
          FROM nodes n
          WHERE 1=1
        `;
      let countQuery = `SELECT COUNT(*) as count FROM nodes n WHERE 1=1`;

      const params: any[] = [];
      const conditions: string[] = [];

      // 添加ID过滤
      if (criteria.ids && criteria.ids.length > 0) {
        conditions.push(`n.id IN (${criteria.ids.map(() => "?").join(", ")})`);
        params.push(...criteria.ids);
      }

      // 添加类型过滤
      if (criteria.types && criteria.types.length > 0) {
        conditions.push(
          `n.type IN (${criteria.types.map(() => "?").join(", ")})`
        );
        params.push(...criteria.types);
      }

      // 添加标签过滤
      if (criteria.labels && criteria.labels.length > 0) {
        conditions.push(
          `n.label IN (${criteria.labels.map(() => "?").join(", ")})`
        );
        params.push(...criteria.labels);
      }

      // 添加标签包含过滤
      if (criteria.labelContains) {
        conditions.push(`n.label LIKE ?`);
        params.push(`%${criteria.labelContains}%`);
      }

      // 添加时间范围过滤
      if (criteria.createdAfter) {
        conditions.push(`n.created_at >= ?`);
        params.push(criteria.createdAfter.toISOString());
      }

      if (criteria.createdBefore) {
        conditions.push(`n.created_at <= ?`);
        params.push(criteria.createdBefore.toISOString());
      }

      if (criteria.updatedAfter) {
        conditions.push(`n.updated_at >= ?`);
        params.push(criteria.updatedAfter.toISOString());
      }

      if (criteria.updatedBefore) {
        conditions.push(`n.updated_at <= ?`);
        params.push(criteria.updatedBefore.toISOString());
      }

      // 添加属性过滤
      if (criteria.properties && criteria.properties.length > 0) {
        for (let i = 0; i < criteria.properties.length; i++) {
          const prop = criteria.properties[i];
          const propAlias = `p${i}`;

          // 根据操作符构建不同的条件
          let propCondition: string;
          switch (prop.operator) {
            case FilterOperator.EXISTS:
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ?)`;
              params.push(prop.key);
              break;
            case FilterOperator.NOT_EXISTS:
              propCondition = `NOT EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ?)`;
              params.push(prop.key);
              break;
            case FilterOperator.EQUALS:
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND ${propAlias}.value = ?)`;
              params.push(prop.key, JSON.stringify(prop.value));
              break;
            case FilterOperator.NOT_EQUALS:
              propCondition = `NOT EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND ${propAlias}.value = ?)`;
              params.push(prop.key, JSON.stringify(prop.value));
              break;
            case FilterOperator.CONTAINS:
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND ${propAlias}.value LIKE ?)`;
              params.push(
                prop.key,
                `%${JSON.stringify(prop.value).slice(1, -1)}%`
              );
              break;
            case FilterOperator.STARTS_WITH:
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND ${propAlias}.value LIKE ?)`;
              params.push(
                prop.key,
                `${JSON.stringify(prop.value).slice(1, -1)}%`
              );
              break;
            case FilterOperator.ENDS_WITH:
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND ${propAlias}.value LIKE ?)`;
              params.push(
                prop.key,
                `%${JSON.stringify(prop.value).slice(1, -1)}`
              );
              break;
            // 其他数值比较操作符
            case FilterOperator.GREATER_THAN:
            case FilterOperator.GREATER_THAN_OR_EQUAL:
            case FilterOperator.LESS_THAN:
            case FilterOperator.LESS_THAN_OR_EQUAL:
              const opMap: Record<string, string> = {
                [FilterOperator.GREATER_THAN]: ">",
                [FilterOperator.GREATER_THAN_OR_EQUAL]: ">=",
                [FilterOperator.LESS_THAN]: "<",
                [FilterOperator.LESS_THAN_OR_EQUAL]: "<=",
              };
              propCondition = `EXISTS (SELECT 1 FROM node_properties ${propAlias} WHERE ${propAlias}.node_id = n.id AND ${propAlias}.key = ? AND CAST(JSON_EXTRACT(${propAlias}.value, '$') AS NUMERIC) ${
                opMap[prop.operator]
              } ?)`;
              params.push(prop.key, prop.value);
              break;
            default:
              // 跳过不支持的操作符
              continue;
          }
          conditions.push(propCondition);
        }
      }

      // 添加所有条件到查询
      if (conditions.length > 0) {
        const whereClause = conditions.join(" AND ");
        query += ` AND ${whereClause}`;
        countQuery += ` AND ${whereClause}`;
      }

      // 添加排序
      if (criteria.sortBy) {
        query += ` ORDER BY n.${criteria.sortBy.field} ${criteria.sortBy.direction}`;
      } else {
        // 默认按创建时间排序
        query += ` ORDER BY n.created_at DESC`;
      }

      // 添加分页
      if (criteria.limit) {
        query += ` LIMIT ?`;
        params.push(criteria.limit);

        if (criteria.offset) {
          query += ` OFFSET ?`;
          params.push(criteria.offset);
        }
      }

      // 执行查询
      const result = await this.db!.query(query, params);
      const nodes = result.values || [];

      // 查询总数
      const countResult = await this.db!.query(
        countQuery,
        params.slice(
          0,
          params.length - (criteria.limit ? (criteria.offset ? 2 : 1) : 0)
        )
      );
      const totalCount = countResult.values?.[0]?.count || 0;

      // 获取节点属性
      const nodeObjects: GraphNode[] = [];
      for (const node of nodes) {
        const properties = await this._getNodeProperties(node.id);
        nodeObjects.push({
          ...node,
          is_independent: node.is_independent === 1,
          properties,
        });
      }

      return { nodes: nodeObjects, totalCount };
    };
    try {
      if (isTransaction) {
        return await this.db!.transaction(searchNodesOperation);
      } else {
        return await searchNodesOperation();
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to search nodes: ${error}`,
        error as Error
      );
    }
  }

  // 搜索关系
  async searchEdges(
    criteria: EdgeSearchCriteria,
    isTransaction = true
  ): Promise<{ edges: GraphEdge[]; totalCount: number }> {
    if (!this.db) throw new DatabaseError("Database not initialized");
    const searchEdgesOperation = async () => {
      // 构建基本查询
      let query = `
        SELECT e.id, e.source_id, e.target_id, e.type, e.created_at
        FROM relationships e
        WHERE 1=1
      `;
      let countQuery = `SELECT COUNT(*) as count FROM relationships e WHERE 1=1`;
      const params: any[] = [];
      const conditions: string[] = [];
      const joins: string[] = [];
      // ...原有条件拼接逻辑...
      // ...省略...
      // 执行查询
      const result = await this.db!.query(query, params);
      const edges = result.values || [];
      // 查询总数
      const countParams = params.slice(
        0,
        params.length -
          (criteria.limit !== undefined
            ? criteria.offset !== undefined
              ? 2
              : 1
            : 0)
      );
      const countResult = await this.db!.query(countQuery, countParams);
      const totalCount = countResult.values?.[0]?.count || 0;
      // 结构化关系处理
      const processedRelNodeIds = new Set<string>();
      const processedEdgeIds = new Set<string>();
      const resultEdges: GraphEdge[] = [];
      // 1. 先处理结构化关系（RELATIONSHIP_TYPE节点 + 两条_relay边）
      const relNodesResult = await this.db!.query(
        "SELECT * FROM nodes WHERE type = ?",
        [GraphNodeType.RELATIONSHIP_TYPE]
      );
      const relNodes = relNodesResult?.values || [];
      for (const relNode of relNodes) {
        const relayEdgesResult = await this.db!.query(
          `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?) AND type = ?`,
          [relNode.id, relNode.id, RelayRelationshipType.RELAY]
        );
        const relayEdges = relayEdgesResult?.values || [];
        if (relayEdges.length !== 2) continue;
        let sourceId = "",
          targetId = "";
        let relayEdgeIds: [string, string] = [
          relayEdges[0].id,
          relayEdges[1].id,
        ];
        for (const edge of relayEdges) {
          if (edge.source_id === relNode.id) {
            targetId = edge.target_id;
          } else if (edge.target_id === relNode.id) {
            sourceId = edge.source_id;
          }
        }
        if (!sourceId || !targetId) continue;
        if (
          typeof relNode.id !== "string" ||
          typeof relayEdgeIds[0] !== "string" ||
          typeof relayEdgeIds[1] !== "string"
        )
          continue;
        resultEdges.push({
          id: relNode.id,
          source_id: sourceId,
          target_id: targetId,
          type: relNode.label || "",
          created_at: relNode.created_at,
          properties: relNode.properties || {},
          isStructured: true,
          structuredMeta: {
            relationshipNodeId: relNode.id,
            relayEdgeIds,
            label: relNode.label || "",
            properties: relNode.properties || {},
          },
        });
        processedRelNodeIds.add(relNode.id);
        relayEdges.forEach((e) => processedEdgeIds.add(e.id));
      }
      // 2. 处理普通边（非_relay边，且未被结构化关系覆盖）
      for (const edgeRow of edges) {
        if (processedEdgeIds.has(edgeRow.id)) continue;
        if (edgeRow.type === RelayRelationshipType.RELAY) continue;
        const properties = await this._getEdgeProperties(edgeRow.id);
        resultEdges.push({
          ...edgeRow,
          properties,
          isStructured: false,
        });
      }
      return { edges: resultEdges, totalCount };
    };
    try {
      if (isTransaction) {
        return await this.db!.transaction(searchEdgesOperation);
      } else {
        return await searchEdgesOperation();
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to search edges: ${error}`,
        error as Error
      );
    }
  }

  // 全文搜索
  async fullTextSearch(
    query: string,
    options?: FullTextSearchOptions,
    isTransaction = true
  ): Promise<{
    nodes: GraphNode[];
    edges: GraphEdge[];
    totalNodeCount: number;
    totalEdgeCount: number;
  }> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const opts = {
      includeTitles: true,
      includeProperties: true,
      caseSensitive: false,
      limit: 100,
      offset: 0,
      ...options,
    };
    const fullTextSearchOperation = async () => {
      const searchPattern = opts.caseSensitive ? query : query.toLowerCase();
      const likePattern = `%${searchPattern}%`;

      // 节点搜索
      let nodeQuery = `SELECT n.id FROM nodes n WHERE 1=1`;
      const nodeConditions: string[] = [];
      const nodeParams: any[] = [];

      if (opts.includeTitles) {
        nodeConditions.push(
          `${opts.caseSensitive ? "n.label" : "LOWER(n.label)"} LIKE ?`
        );
        nodeParams.push(likePattern);
      }

      // 属性搜索
      if (opts.includeProperties) {
        nodeConditions.push(
          `EXISTS (SELECT 1 FROM node_properties np WHERE np.node_id = n.id AND ${
            opts.caseSensitive ? "np.value" : "LOWER(np.value)"
          } LIKE ?)`
        );
        nodeParams.push(likePattern);
      }

      if (nodeConditions.length > 0) {
        nodeQuery += ` AND (${nodeConditions.join(" OR ")})`;
      }

      // 边搜索
      let edgeQuery = `SELECT e.id FROM relationships e WHERE 1=1`;
      const edgeConditions: string[] = [];
      const edgeParams: any[] = [];

      // 类型匹配搜索
      if (opts.includeTitles) {
        edgeConditions.push(
          `${opts.caseSensitive ? "e.type" : "LOWER(e.type)"} LIKE ?`
        );
        edgeParams.push(likePattern);
      }

      // 属性搜索
      if (opts.includeProperties) {
        edgeConditions.push(
          `EXISTS (SELECT 1 FROM relationship_properties ep WHERE ep.relationship_id = e.id AND ${
            opts.caseSensitive ? "ep.value" : "LOWER(ep.value)"
          } LIKE ?)`
        );
        edgeParams.push(likePattern);
      }

      if (edgeConditions.length > 0) {
        edgeQuery += ` AND (${edgeConditions.join(" OR ")})`;
      }

      // 查询ID
      const nodeResult = await this.db!.query(nodeQuery, nodeParams);
      const edgeResult = await this.db!.query(edgeQuery, edgeParams);

      const nodeIds = (nodeResult.values || []).map((row: any) => row.id);
      const edgeIds = (edgeResult.values || []).map((row: any) => row.id);

      // 获取完整数据 - 使用分页限制
      const limitedNodeIds = nodeIds.slice(
        opts.offset,
        opts.offset + opts.limit
      );
      const limitedEdgeIds = edgeIds.slice(
        opts.offset,
        opts.offset + opts.limit
      );

      const nodes: GraphNode[] = [];
      for (const id of limitedNodeIds) {
        try {
          const node = await this.getNode(id); // Uses _getNodeProperties internally
          nodes.push(node);
        } catch (e) {
          // 忽略不存在的节点
        }
      }

      const edges: GraphEdge[] = [];
      for (const id of limitedEdgeIds) {
        try {
          const edge = await this.getEdge(id); // Uses _getEdgeProperties internally
          edges.push(edge);
        } catch (e) {
          // 忽略不存在的边
        }
      }

      // 总数是未分页前的ID数量
      const totalNodeCount = nodeIds.length;
      const totalEdgeCount = edgeIds.length;

      return {
        nodes,
        edges,
        totalNodeCount,
        totalEdgeCount,
      };
    };
    try {
      if (isTransaction) {
        return await this.db!.transaction(fullTextSearchOperation);
      } else {
        return await fullTextSearchOperation();
      }
    } catch (error) {
      throw new DatabaseError(
        `Failed to perform full text search: ${error}`,
        error as Error
      );
    }
  }

  // 辅助方法：获取节点属性 - Renamed
  private async _getNodeProperties(
    nodeId: string
  ): Promise<Record<string, any>> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const result = await this.db.query(
      `SELECT key, value FROM node_properties WHERE node_id = ?`,
      [nodeId]
    );

    const properties: Record<string, any> = {};
    for (const row of result.values || []) {
      try {
        properties[row.key] = JSON.parse(row.value);
      } catch (e) {
        properties[row.key] = row.value;
      }
    }

    return properties;
  }

  // 辅助方法：获取关系属性 - Renamed
  private async _getEdgeProperties(
    edgeId: string
  ): Promise<Record<string, any>> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const result = await this.db.query(
      `SELECT key, value FROM relationship_properties WHERE relationship_id = ?`,
      [edgeId]
    );

    const properties: Record<string, any> = {};
    for (const row of result.values || []) {
      try {
        properties[row.key] = JSON.parse(row.value);
      } catch (e) {
        properties[row.key] = row.value;
      }
    }

    return properties;
  }

  // 获取与指定节点相关的所有边 (Modified to handle structured relationships)
  public async getEdgesForNode(nodeId: string): Promise<GraphEdge[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 检查节点是否存在
      const nodeExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [nodeId]
      );
      if (!nodeExistsResult?.values || nodeExistsResult.values.length === 0) {
        throw new NodeNotFoundError(nodeId);
      }

      // 获取所有与该节点相关的边
      const directEdgesResult = await this.db.query(
        `SELECT * FROM relationships WHERE source_id = ? OR target_id = ?`,
        [nodeId, nodeId]
      );
      if (!directEdgesResult?.values || directEdgesResult.values.length === 0) {
        return [];
      }

      const allDirectEdges: any[] = directEdgesResult.values;
      const processedEdgeIds = new Set<string>();
      const resultEdges: GraphEdge[] = [];

      // 1. 处理结构化关系
      for (const edgeRow of allDirectEdges) {
        if (processedEdgeIds.has(edgeRow.id)) continue;
        // 只处理 _relay 边
        if (edgeRow.type !== RelayRelationshipType.RELAY) continue;
        // 判断是出边还是入边
        let relNodeId = "";
        let isOutgoing = false;
        if (edgeRow.source_id === nodeId) {
          relNodeId = edgeRow.target_id;
          isOutgoing = true;
        } else if (edgeRow.target_id === nodeId) {
          relNodeId = edgeRow.source_id;
        } else {
          continue;
        }
        // 检查 relNode 是否为类型节点
        try {
          const relNode = await this.getNode(relNodeId);
          if (relNode && relNode.type === GraphNodeType.RELATIONSHIP_TYPE) {
            // 查找另一条 _relay 边
            const otherRelayResult = await this.db.query(
              isOutgoing
                ? `SELECT * FROM relationships WHERE source_id = ? AND type = ?`
                : `SELECT * FROM relationships WHERE target_id = ? AND type = ?`,
              [relNodeId, RelayRelationshipType.RELAY]
            );
            const otherRelayEdges = otherRelayResult?.values || [];
            for (const otherEdge of otherRelayEdges) {
              if (isOutgoing && otherEdge.target_id === nodeId) continue; // 跳过自身
              if (!isOutgoing && otherEdge.source_id === nodeId) continue;
              // 组装结构化边
              const sourceId = isOutgoing ? nodeId : otherEdge.source_id;
              const targetId = isOutgoing ? otherEdge.target_id : nodeId;
              if (typeof sourceId !== "string" || typeof targetId !== "string")
                continue;
              if (
                typeof edgeRow.id !== "string" ||
                typeof otherEdge.id !== "string"
              )
                continue;
              if (typeof relNode.id !== "string") continue;
              resultEdges.push({
                id: relNode.id,
                source_id: sourceId,
                target_id: targetId,
                type: relNode.label || "",
                created_at: relNode.created_at || edgeRow.created_at,
                properties: relNode.properties || {},
                isStructured: true,
                structuredMeta: {
                  relationshipNodeId: relNode.id,
                  relayEdgeIds: isOutgoing
                    ? [edgeRow.id, otherEdge.id]
                    : [otherEdge.id, edgeRow.id],
                  label: relNode.label || "",
                  properties: relNode.properties || {},
                },
              });
              processedEdgeIds.add(edgeRow.id);
              processedEdgeIds.add(otherEdge.id);
            }
          }
        } catch (e) {
          /* getNode 失败忽略 */
        }
      }

      // 2. 处理普通边
      for (const edgeRow of allDirectEdges) {
        if (processedEdgeIds.has(edgeRow.id)) continue;
        if (edgeRow.type === RelayRelationshipType.RELAY) continue;
        // 获取属性
        const propsResult = await this.db.query(
          "SELECT key, value FROM relationship_properties WHERE relationship_id = ?",
          [edgeRow.id]
        );
        const properties: Record<string, any> = {};
        if (propsResult?.values && propsResult.values.length > 0) {
          for (const propRow of propsResult.values) {
            let key: string;
            let rawValue: string;
            if (Array.isArray(propRow)) {
              key = propRow[0];
              rawValue = propRow[1];
            } else {
              key = propRow.key;
              rawValue = propRow.value;
            }
            try {
              properties[key] = JSON.parse(rawValue);
            } catch (e) {
              properties[key] = rawValue;
            }
          }
        }
        resultEdges.push({
          id: edgeRow.id,
          source_id: edgeRow.source_id,
          target_id: edgeRow.target_id,
          type: edgeRow.type,
          created_at: edgeRow.created_at,
          properties,
          isStructured: false,
        });
      }
      return resultEdges;
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to get edges for node: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // 获取两个节点之间的边 (Modified to handle structured relationships)
  public async getEdgesBetweenNodes(
    sourceId: string,
    targetId: string
  ): Promise<GraphEdge[]> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 1. Validate source and target nodes exist
      const sourceExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [sourceId]
      );
      if (
        !sourceExistsResult?.values ||
        sourceExistsResult.values.length === 0
      ) {
        throw new NodeNotFoundError(sourceId);
      }
      const targetExistsResult = await this.db.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [targetId]
      );
      if (
        !targetExistsResult?.values ||
        targetExistsResult.values.length === 0
      ) {
        throw new NodeNotFoundError(targetId);
      }

      const resultEdges: GraphEdge[] = [];
      const processedRelNodeIds = new Set<string>();
      const processedEdgeIds = new Set<string>();

      // 1. 查找结构化关系
      // 查找 sourceId -> RELATIONSHIP_TYPE -> targetId
      const outgoingRelays = await this.db.query(
        `SELECT * FROM relationships WHERE source_id = ? AND type = ?`,
        [sourceId, RelayRelationshipType.RELAY]
      );
      if (outgoingRelays?.values) {
        for (const firstRelay of outgoingRelays.values) {
          const relNodeId = firstRelay.target_id;
          if (processedRelNodeIds.has(relNodeId)) continue;
          try {
            const relNode = await this.getNode(relNodeId);
            if (
              relNode &&
              relNode.type === GraphNodeType.RELATIONSHIP_TYPE &&
              typeof relNode.id === "string"
            ) {
              const secondRelayResult = await this.db!.query(
                `SELECT * FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?`,
                [relNodeId, targetId, RelayRelationshipType.RELAY]
              );
              if (
                secondRelayResult?.values &&
                secondRelayResult.values.length > 0
              ) {
                for (const secondRelay of secondRelayResult.values) {
                  if (
                    typeof firstRelay.id !== "string" ||
                    typeof secondRelay.id !== "string"
                  )
                    continue;
                  resultEdges.push({
                    id: relNode.id,
                    source_id: sourceId,
                    target_id: targetId,
                    type: relNode.label || "",
                    created_at: relNode.created_at || firstRelay.created_at,
                    properties: relNode.properties || {},
                    isStructured: true,
                    structuredMeta: {
                      relationshipNodeId: relNode.id,
                      relayEdgeIds: [firstRelay.id, secondRelay.id],
                      label: relNode.label || "",
                      properties: relNode.properties || {},
                    },
                  });
                  processedRelNodeIds.add(relNode.id);
                  processedEdgeIds.add(firstRelay.id);
                  processedEdgeIds.add(secondRelay.id);
                }
              }
            }
          } catch (e) {
            /* getNode failed, ignore */
          }
        }
      }
      // 查找 targetId -> RELATIONSHIP_TYPE -> sourceId
      const outgoingRelays2 = await this.db!.query(
        `SELECT * FROM relationships WHERE source_id = ? AND type = ?`,
        [targetId, RelayRelationshipType.RELAY]
      );
      if (outgoingRelays2?.values) {
        for (const firstRelay of outgoingRelays2.values) {
          const relNodeId = firstRelay.target_id;
          if (processedRelNodeIds.has(relNodeId)) continue;
          try {
            const relNode = await this.getNode(relNodeId);
            if (
              relNode &&
              relNode.type === GraphNodeType.RELATIONSHIP_TYPE &&
              typeof relNode.id === "string"
            ) {
              const secondRelayResult = await this.db!.query(
                `SELECT * FROM relationships WHERE source_id = ? AND target_id = ? AND type = ?`,
                [relNodeId, sourceId, RelayRelationshipType.RELAY]
              );
              if (
                secondRelayResult?.values &&
                secondRelayResult.values.length > 0
              ) {
                for (const secondRelay of secondRelayResult.values) {
                  if (
                    typeof firstRelay.id !== "string" ||
                    typeof secondRelay.id !== "string"
                  )
                    continue;
                  resultEdges.push({
                    id: relNode.id,
                    source_id: targetId,
                    target_id: sourceId,
                    type: relNode.label || "",
                    created_at: relNode.created_at || firstRelay.created_at,
                    properties: relNode.properties || {},
                    isStructured: true,
                    structuredMeta: {
                      relationshipNodeId: relNode.id,
                      relayEdgeIds: [firstRelay.id, secondRelay.id],
                      label: relNode.label || "",
                      properties: relNode.properties || {},
                    },
                  });
                  processedRelNodeIds.add(relNode.id);
                  processedEdgeIds.add(firstRelay.id);
                  processedEdgeIds.add(secondRelay.id);
                }
              }
            }
          } catch (e) {
            /* getNode failed, ignore */
          }
        }
      }

      // 2. 查找普通边（非_relay，且未被结构化关系覆盖）
      const directEdgesResult = await this.db.query(
        `SELECT * FROM relationships 
         WHERE type != ? AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`,
        [RelayRelationshipType.RELAY, sourceId, targetId, targetId, sourceId]
      );
      if (directEdgesResult?.values) {
        for (const edgeRow of directEdgesResult.values) {
          if (processedEdgeIds.has(edgeRow.id)) continue;
          // 获取属性
          const propsResult = await this.db!.query(
            "SELECT key, value FROM relationship_properties WHERE relationship_id = ?",
            [edgeRow.id]
          );
          const properties: Record<string, any> = {};
          if (propsResult?.values && propsResult.values.length > 0) {
            for (const propRow of propsResult.values) {
              let key: string;
              let rawValue: string;
              if (Array.isArray(propRow)) {
                key = propRow[0];
                rawValue = propRow[1];
              } else {
                key = propRow.key;
                rawValue = propRow.value;
              }
              try {
                properties[key] = JSON.parse(rawValue);
              } catch (e) {
                properties[key] = rawValue;
              }
            }
          }
          resultEdges.push({
            id: edgeRow.id,
            source_id: edgeRow.source_id,
            target_id: edgeRow.target_id,
            type: edgeRow.type,
            created_at: edgeRow.created_at,
            properties,
            isStructured: false,
          });
        }
      }
      return resultEdges;
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to get edges between nodes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Find the parent independent node for a given non-independent node
  async findParentIndependentNode(nodeId: string): Promise<GraphNode | null> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    try {
      // 1. Verify the current node exists and is NOT independent
      const currentNode = await this.getNode(nodeId);
      if (!currentNode || currentNode.is_independent) {
        // Not found or is already independent, return null
        return null;
      }

      // 2. Find all parent nodes (nodes pointing TO this node)
      const parentEdgesResult = await this.db.query(
        `SELECT source_id FROM relationships WHERE target_id = ?`,
        [nodeId]
      );

      if (!parentEdgesResult?.values || parentEdgesResult.values.length === 0) {
        return null; // No parents found
      }

      const parentIds = parentEdgesResult.values
        .map((row: any) => row.source_id)
        .filter((id) => id);

      if (parentIds.length === 0) {
        return null; // No valid parent IDs
      }

      // 3. Fetch details of parent nodes, filtering for independent ones
      const parentNodesResult = await this.db.query(
        `SELECT *, is_independent FROM nodes WHERE id IN (${parentIds
          .map(() => "?")
          .join(", ")}) AND is_independent = 1`,
        parentIds
      );

      if (!parentNodesResult?.values || parentNodesResult.values.length === 0) {
        return null; // No independent parents found
      }

      // 4. Convert raw results to GraphNode objects and parse is_independent
      const independentParents: GraphNode[] = parentNodesResult.values.map(
        (row: any) => ({
          ...row,
          is_independent: row.is_independent === 1,
          // Note: Properties are not fetched here for simplicity,
          // as we primarily need created_at for sorting.
          // Fetch properties if needed later.
        })
      );

      // 5. Sort independent parents by created_at (ascending)
      independentParents.sort((a, b) => {
        const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return dateA - dateB;
      });

      // 6. Return the earliest independent parent
      return independentParents[0];
    } catch (error) {
      if (error instanceof NodeNotFoundError) {
        // If the original node wasn't found by getNode
        return null;
      }
      // Log the error for debugging, but might return null to the caller
      console.error(
        `Failed to find parent independent node for ${nodeId}:`,
        error
      );
      // Rethrow or return null based on desired error handling
      throw new DatabaseError(
        `Failed to find parent independent node: ${error}`,
        error as Error
      );
    }
  }
  // TODO: 这个API还没有进行人工测试, 因为用处不大, 所以以后用到再测
  async createStructuredRelationship(
    sourceNodeId: string,
    targetNodeId: string,
    relationshipLabel: string,
    properties?: Record<string, any>,
    isTransaction = true
  ): Promise<string> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    // This inner function will operate assuming this.db is transactional
    // if called within the this.db.transaction block.
    const operation = async () => {
      // 1. Validate source and target nodes exist
      // It's important that this.db (or this.db!) refers to the transactional DB connection here.
      const sourceExists = await this.db!.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [sourceNodeId]
      );
      if (!sourceExists?.values || sourceExists.values.length === 0) {
        throw new NodeNotFoundError(
          `Source node with id ${sourceNodeId} not found.`
        );
      }

      const targetExists = await this.db!.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [targetNodeId]
      );
      if (!targetExists?.values || targetExists.values.length === 0) {
        throw new NodeNotFoundError(
          `Target node with id ${targetNodeId} not found.`
        );
      }

      // 2. Create the relationship type node
      const relationshipNodeId = uuidv4();

      // These calls to this.addNode and this.addEdge will use their own internal transaction logic.
      // If this.addNode/this.addEdge are called while this.db is already part of an outer transaction
      // (started by this.db.transaction below), their behavior regarding nested transactions
      // depends on the specific SQLiteEngine implementation (e.g., sql.js, capacitor-sqlite).
      // Ideally, they would join the existing transaction.
      await this.addNode({
        id: relationshipNodeId,
        label: relationshipLabel,
        type: GraphNodeType.RELATIONSHIP_TYPE,
        is_independent: true,
        properties: properties,
      });

      // 3. Create the first relay edge
      await this.addEdge({
        source_id: sourceNodeId,
        target_id: relationshipNodeId,
        type: RelayRelationshipType.RELAY,
      });

      // 4. Create the second relay edge
      await this.addEdge({
        source_id: relationshipNodeId,
        target_id: targetNodeId,
        type: RelayRelationshipType.RELAY,
      });

      return relationshipNodeId;
    };

    // Execute the entire operation within a single transaction if possible.
    // This relies on the this.db.transaction() method correctly setting up a transactional context
    // that this.addNode and this.addEdge can participate in, or that their individual transactions
    // are acceptable within this larger conceptual operation.
    try {
      // Assuming this.db.transaction makes this.db transactional for the scope of the callback.
      if (isTransaction) {
        return await this.db!.transaction(operation);
      } else {
        return await operation();
      }
    } catch (error) {
      console.error("Failed to create structured relationship:", error);
      if (
        error instanceof NodeNotFoundError ||
        error instanceof DatabaseError
      ) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to create structured relationship: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  public async convertToStructuredRelationship(
    edgeId: string,
    relationshipLabel?: string,
    properties?: Record<string, any>,
    isTransaction = true
  ): Promise<string> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const operation = async () => {
      // 1. Get the existing edge
      let edgeToConvert: GraphEdge;
      try {
        edgeToConvert = await this.getEdge(edgeId);
      } catch (error) {
        if (error instanceof Error && error.message.includes("not found")) {
          throw new EdgeNotFoundError(edgeId);
        }
        throw new DatabaseError(
          `Failed to retrieve edge ${edgeId} for conversion: ${error}`
        );
      }

      // 2. Validate it's not a _relay edge
      if (edgeToConvert.type === RelayRelationshipType.RELAY) {
        // Use the globally available ValidationError
        throw new ValidationError(
          `Edge ${edgeId} is already a _relay edge and cannot be converted.`
        );
      }

      // Ensure source_id and target_id exist
      if (!edgeToConvert.source_id || !edgeToConvert.target_id) {
        // Use the globally available ValidationError
        throw new ValidationError(
          `Edge ${edgeId} is missing source_id or target_id and cannot be converted.`
        );
      }

      // 3. Determine label and properties for the new RELATIONSHIP_TYPE node
      const newRelNodeLabel =
        relationshipLabel || edgeToConvert.type || "converted_relationship"; // Use provided, original type, or default
      const newRelNodeProperties = properties || edgeToConvert.properties || {}; // Use provided, original properties, or empty

      // 4. Create the RELATIONSHIP_TYPE node
      // Note: Using internal this.addNode which might start its own sub-transaction.
      // For true atomicity, direct DB operations might be preferred if sub-transactions are an issue.
      // However, addNode handles ID generation and property insertion correctly.
      const relationshipNodeId = await this.addNode(
        {
          // id: uuidv4(), // addNode will generate an ID if not provided
          label: newRelNodeLabel,
          type: GraphNodeType.RELATIONSHIP_TYPE,
          is_independent: true, // RELATIONSHIP_TYPE nodes are typically independent entities
          properties: newRelNodeProperties,
        },
        false
      );

      // 5. Create the first relay edge (source -> RELATIONSHIP_TYPE_NODE)
      await this.addEdge(
        {
          source_id: edgeToConvert.source_id,
          target_id: relationshipNodeId,
          type: RelayRelationshipType.RELAY,
        },
        false
      );

      // 6. Create the second relay edge (RELATIONSHIP_TYPE_NODE -> target)
      await this.addEdge(
        {
          source_id: relationshipNodeId,
          target_id: edgeToConvert.target_id,
          type: RelayRelationshipType.RELAY,
        },
        false
      );

      // 7. Delete the original edge and its properties
      await this.deleteEdge(edgeId, false); // deleteEdge handles properties and the edge itself in a transaction

      return relationshipNodeId;
    };
    if (isTransaction) {
      return await this.db!.transaction(operation);
    } else {
      return await operation();
    }
  }

  /**
   * Move all relationships from one node to another, properly handling both structured and regular relationships.
   * This method ensures that structured relationships maintain their integrity by updating the appropriate
   * _relay edges rather than breaking the relationship structure.
   *
   * @param fromNodeId The ID of the node to move relationships from
   * @param toNodeId The ID of the node to move relationships to
   */
  async moveRelationships(
    fromNodeId: string,
    toNodeId: string,
    isTransaction = true
  ): Promise<void> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const operation = async () => {
      // Validate that both nodes exist
      const fromNodeExists = await this.db!.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [fromNodeId]
      );
      if (!fromNodeExists?.values || fromNodeExists.values.length === 0) {
        throw new NodeNotFoundError(
          `Source node with id ${fromNodeId} not found.`
        );
      }

      const toNodeExists = await this.db!.query(
        "SELECT 1 FROM nodes WHERE id = ?",
        [toNodeId]
      );
      if (!toNodeExists?.values || toNodeExists.values.length === 0) {
        throw new NodeNotFoundError(
          `Target node with id ${toNodeId} not found.`
        );
      }

      // Get all relationships for the source node
      const edges = await this.getEdgesForNode(fromNodeId);

      // Process each relationship
      for (const edge of edges) {
        // Skip edges without IDs (should not happen, but safety check)
        if (!edge.id) {
          console.warn(`Skipping edge without ID during moveRelationships`);
          continue;
        }

        // Determine new source and target IDs
        const newSourceId =
          edge.source_id === fromNodeId ? toNodeId : edge.source_id;
        const newTargetId =
          edge.target_id === fromNodeId ? toNodeId : edge.target_id;

        // Skip self-loops that would be created
        if (newSourceId === newTargetId) continue;

        // Check for existing duplicate relationships
        const existingEdges = await this.getEdgesBetweenNodes(
          newSourceId,
          newTargetId
        );
        const hasDuplicate = existingEdges.some((e) => e.type === edge.type);

        // Skip if duplicate exists
        if (hasDuplicate) continue;

        // Update the relationship using the existing updateEdge method
        // This method automatically handles both structured and regular relationships
        const updates: Partial<GraphEdge> = {};
        if (edge.source_id === fromNodeId) {
          updates.source_id = toNodeId;
        }
        if (edge.target_id === fromNodeId) {
          updates.target_id = toNodeId;
        }

        // Use updateEdge which knows how to handle structured relationships
        await this.updateEdge(edge.id, updates, false);
      }
    };

    try {
      if (isTransaction) {
        return await this.db!.transaction(operation);
      } else {
        return await operation();
      }
    } catch (error) {
      console.error("Failed to move relationships:", error);
      if (
        error instanceof NodeNotFoundError ||
        error instanceof DatabaseError
      ) {
        throw error;
      }
      throw new DatabaseError(
        `Failed to move relationships from ${fromNodeId} to ${toNodeId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Self-check API to validate structured relationships integrity.
   * Tests for invalid structured relationship configurations and reports issues.
   *
   * @param isTransaction Whether to run in transaction context
   * @returns ValidationResult with detailed information about any issues found
   */
  async validateStructuredRelationships(
    isTransaction = true
  ): Promise<ValidationResult> {
    if (!this.db) throw new DatabaseError("Database not initialized");

    const operation = async (): Promise<ValidationResult> => {
      const errors: string[] = [];
      let validStructuredRelationships = 0;
      let invalidStructuredRelationships = 0;

      try {
        // 1. Get all RELATIONSHIP_TYPE nodes
        const relNodesResult = await this.db!.query(
          "SELECT * FROM nodes WHERE type = ?",
          [GraphNodeType.RELATIONSHIP_TYPE]
        );
        const relNodes = relNodesResult?.values || [];

        console.log(
          `[StructuredRelationshipValidator] Found ${relNodes.length} RELATIONSHIP_TYPE nodes`
        );

        for (const relNode of relNodes) {
          const nodeId = relNode.id;
          let nodeHasIssues = false;

          // 2. Check if each RELATIONSHIP_TYPE node has exactly 2 _relay edges
          const relayEdgesResult = await this.db!.query(
            `SELECT * FROM relationships WHERE (source_id = ? OR target_id = ?) AND type = ?`,
            [nodeId, nodeId, RelayRelationshipType.RELAY]
          );
          const relayEdges = relayEdgesResult?.values || [];

          if (relayEdges.length !== 2) {
            errors.push(
              `RELATIONSHIP_TYPE node '${nodeId}' (label: '${relNode.label}') has ${relayEdges.length} _relay edges, expected exactly 2`
            );
            nodeHasIssues = true;
            invalidStructuredRelationships++;
          } else {
            // 3. Validate the structure: should have one incoming and one outgoing _relay edge
            let incomingCount = 0;
            let outgoingCount = 0;
            let sourceNodeId = "";
            let targetNodeId = "";

            for (const edge of relayEdges) {
              if (edge.source_id === nodeId) {
                outgoingCount++;
                targetNodeId = edge.target_id;
              }
              if (edge.target_id === nodeId) {
                incomingCount++;
                sourceNodeId = edge.source_id;
              }
            }

            if (incomingCount !== 1 || outgoingCount !== 1) {
              errors.push(
                `RELATIONSHIP_TYPE node '${nodeId}' has invalid _relay edge structure: ${incomingCount} incoming, ${outgoingCount} outgoing (expected 1 each)`
              );
              nodeHasIssues = true;
              invalidStructuredRelationships++;
            } else {
              // 4. Verify that source and target nodes actually exist
              if (sourceNodeId) {
                const sourceExists = await this.db!.query(
                  "SELECT 1 FROM nodes WHERE id = ?",
                  [sourceNodeId]
                );
                if (!sourceExists?.values || sourceExists.values.length === 0) {
                  errors.push(
                    `RELATIONSHIP_TYPE node '${nodeId}' references non-existent source node '${sourceNodeId}'`
                  );
                  nodeHasIssues = true;
                  invalidStructuredRelationships++;
                }
              }

              if (targetNodeId) {
                const targetExists = await this.db!.query(
                  "SELECT 1 FROM nodes WHERE id = ?",
                  [targetNodeId]
                );
                if (!targetExists?.values || targetExists.values.length === 0) {
                  errors.push(
                    `RELATIONSHIP_TYPE node '${nodeId}' references non-existent target node '${targetNodeId}'`
                  );
                  nodeHasIssues = true;
                  invalidStructuredRelationships++;
                }
              }

              // 5. Check if source and target are the same (self-loop, which might be invalid)
              if (
                sourceNodeId &&
                targetNodeId &&
                sourceNodeId === targetNodeId
              ) {
                errors.push(
                  `RELATIONSHIP_TYPE node '${nodeId}' creates a self-loop: source and target are both '${sourceNodeId}'`
                );
                nodeHasIssues = true;
                invalidStructuredRelationships++;
              }
            }
          }

          if (!nodeHasIssues) {
            validStructuredRelationships++;
          }
        }

        // 6. Check for orphaned _relay edges (not connected to any RELATIONSHIP_TYPE node)
        const allRelayEdgesResult = await this.db!.query(
          "SELECT * FROM relationships WHERE type = ?",
          [RelayRelationshipType.RELAY]
        );
        const allRelayEdges = allRelayEdgesResult?.values || [];

        const relNodeIds = new Set(relNodes.map((n) => n.id));
        for (const edge of allRelayEdges) {
          const isConnectedToRelNode =
            relNodeIds.has(edge.source_id) || relNodeIds.has(edge.target_id);
          if (!isConnectedToRelNode) {
            errors.push(
              `Orphaned _relay edge '${edge.id}' found: not connected to any RELATIONSHIP_TYPE node (source: '${edge.source_id}', target: '${edge.target_id}')`
            );
            invalidStructuredRelationships++;
          }
        }

        // 7. Summary validation result
        const totalStructuredRelationships =
          validStructuredRelationships + invalidStructuredRelationships;
        const isValid = errors.length === 0;

        return {
          valid: isValid,
          nodeCount: relNodes.length,
          edgeCount: allRelayEdges.length,
          errors,
          // Additional metadata specific to structured relationships
          metadata: {
            totalStructuredRelationships,
            validStructuredRelationships,
            invalidStructuredRelationships,
            orphanedRelayEdges: allRelayEdges.length - relNodes.length * 2, // Expected: each rel node should have exactly 2 relay edges
          },
        };
      } catch (error) {
        console.error(
          "[StructuredRelationshipValidator] Validation failed:",
          error
        );
        return {
          valid: false,
          nodeCount: 0,
          edgeCount: 0,
          errors: [
            `Validation failed due to database error: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ],
        };
      }
    };

    try {
      if (isTransaction) {
        return await this.db!.transaction(operation);
      } else {
        return await operation();
      }
    } catch (error) {
      console.error("Failed to validate structured relationships:", error);
      return {
        valid: false,
        nodeCount: 0,
        edgeCount: 0,
        errors: [
          `Validation operation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }
}
