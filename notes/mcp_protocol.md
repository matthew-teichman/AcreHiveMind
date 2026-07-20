# Model Context Protocol (MCP) Architectural Notes
*Technical Reference: Database Integration and Context Injection Patterns*

---

## 1. Overview & Core Philosophy
The **Model Context Protocol (MCP)** is an open-source standard designed to replace bespoke, one-off API integrations between Large Language Models (LLMs) and local/remote data stores. It establishes an explicit, decoupled **Client-Server-Host relationship** to standardize how an LLM discovers, reads, and interacts with external contexts like file systems, web APIs, and databases.

```
       ┌───────────┐          ┌────────────┐          ┌────────────┐
       │   Host    │          │            │          │            │
       │ Application │ <──────> │ MCP Client │ <──────> │ MCP Server │
       │ (e.g. App)  │          │            │          │            │
       └─────┬─────┘          └────────────┘          └─────┬──────┘
             │                                              │
             ▼                                              ▼
       ┌───────────┐                                  ┌────────────┐
       │    LLM    │                                  │  Database  │
       └───────────┘                                  └────────────┘
```

---

## 2. Architectural Components

| Component | Responsibility | Technical Characteristics |
| :--- | :--- | :--- |
| **The Data Layer** | Core persistent storage. | Relational (PostgreSQL), NoSQL (MongoDB), or Graph (Neo4j) engines. |
| **The MCP Server** | Isolated background process containing database connection logic and query parameters. | Written in Python/TypeScript via official `@modelcontextprotocol/sdk`. Exposes schemas and tools. |
| **The MCP Client** | Orchestrator embedded inside the host application. | Manages the transport layer, state synchronization, and prompt injection. |

---

## 3. The Protocol Primitives

MCP divides data interaction into two primary paradigms to interface securely with databases:

### A. Resources (Passive Context)
* **Definition:** Schemaless or semi-structured data sources treated as readable files.
* **Database Application:** Exposing the **Database Schema / DDL** (Data Definition Language).
* **Execution Pattern:** Read asynchronously by the Client at startup to provide the LLM with immediate structural understanding (table names, column types, and relational constraints) inside its system prompt window.

### B. Tools (Active Execution)
* **Definition:** Parameterized, executable functions exposed to the LLM to modify or query state dynamically.
* **Database Application:** Parameterized SQL queries or ORM calls (e.g., `query_customer_orders(customer_id: string)`).
* **Security Control:** Prevents the LLM from executing raw, un-sanitized SQL strings. The server acts as a validation boundary, enforcing parameter types and data access constraints.

---

## 4. End-to-End Data Retrieval Lifecycle

```
[User Query] ──> [LLM Evaluation] ──> [Tool Call Emission] ──> [MCP Client]
                                                                   │
                                                                   ▼ (JSON-RPC)
[Output Generation] <── [LLM Synthesis] <── [Text Payload] <── [MCP Server] <── [SQL Execution]
```

### Phase 1: Capability Discovery (Initialization)
1. The **MCP Client** connects to the **MCP Server** via a transport protocol (typically `stdio` for local processes, or `HTTP/SSE` for remote infrastructure).
2. The Client issues a `tools/list` JSON-RPC request.
3. The Server returns a JSON schema declaring its tool array:
   ```json
   {
     "name": "query_customer_orders",
     "description": "Queries the relational database for a customer's history using their unique customer_id.",
     "inputSchema": {
       "type": "object",
       "properties": {
         "customer_id": { "type": "string" }
       },
       "required": ["customer_id"]
     }
   }
   ```
4. The Client injects this structural definition into the LLM's workspace context.

### Phase 2: Intent Recognition & Routing
1. **User Input:** *"Did customer CUST-9902 place any orders last week?"*
2. **LLM Inference:** The model determines its native parameter set lacks this temporal/transactional data but matches the semantic description of `query_customer_orders`.
3. **Execution Payload:** The LLM halts generation and emits a tool execution request targeting `query_customer_orders` with the argument `{"customer_id": "CUST-9902"}`.

### Phase 3: Execution & Sanitization
1. The **MCP Client** captures the tool execution intent and serializes it into a formal JSON-RPC request routed across the active transport pipeline.
2. The **MCP Server** parses the payload, validates the inputs against the declared JSON schema, and instantiates an isolated connection pool to the database engine.
3. The Server executes a highly secure, parameterized transaction:
   ```sql
   SELECT order_id, order_date, status, total_amount
   FROM customer_orders
   WHERE customer_id = $1
   AND order_date >= NOW() - INTERVAL '7 days';
   ```
4. The database engine returns raw tabular data to the Server.

### Phase 4: Context Injection & Synthesis
1. The **MCP Server** normalizes the raw database records into an MCP-compliant JSON text content block.
2. The **MCP Client** intercepts this message and dynamically injects the textual data back into the LLM's prompt window.
3. **LLM Synthesis:** The model reads the real-time context data rows, maps them to the user's initial query, and generates a natural language answer.

---

## 5. Architectural Advantages

* **Write-Once, Deploy-Everywhere:** Database access modules encapsulated as an MCP server instantly link into any compliant environment (e.g., internal software, Cursor, Windsurf, Claude Desktop) without rebuilding custom integrations.
* **Separation of Concerns:** Isolation of the data retrieval mechanics away from frontend application logic and LLM orchestration layers.
* **Hardened Security Boundary:** The AI model is never granted direct administrative database access; it interacts strictly with highly restricted, pre-compiled tools over secure IPC/RPC communication.