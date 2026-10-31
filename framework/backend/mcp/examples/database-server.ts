#!/usr/bin/env node
/**
 * Database MCP Server Example
 */

import { MCPServer } from '../base/MCPServer.js';
import { MCPTool } from '../base/MCPTool.js';

// Mock database
const mockDb = {
  users: [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
  ],
};

const queryUsersTool = new MCPTool({
  name: 'query_users',
  description: 'Query users from database',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filter by name',
      },
    },
  },
  handler: async (args) => {
    let users = mockDb.users;

    if (args.name) {
      users = users.filter(u => u.name.toLowerCase().includes(args.name.toLowerCase()));
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: users.length, users }, null, 2),
        },
      ],
    };
  },
});

const server = new MCPServer(
  {
    name: 'database-mcp-server',
    version: '1.0.0',
  },
  {
    onStart: async () => {
    },
    onStop: async () => {
    },
  }
);

server.registerTool(queryUsersTool);

// Start server (uncomment when running in Node.js environment)
// server.start().catch(console.error);
// process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
