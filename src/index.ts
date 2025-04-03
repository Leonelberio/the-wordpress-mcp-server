#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

interface WordPressError {
  message: string;
  code?: string;
}

type AxiosError = {
  response?: {
    data?: WordPressError;
  };
  message: string;
};

const isAxiosError = (error: unknown): error is AxiosError => {
  return error !== null && 
         typeof error === 'object' && 
         'message' in error &&
         (error as any).response !== undefined;
};

class WordPressServer {
  private server: Server;
  
  constructor() {
    this.server = new Server(
      {
        name: 'wordpress-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'create_post',
          description: 'Create a new WordPress post',
          inputSchema: {
            type: 'object',
            properties: {
              siteUrl: {
                type: 'string',
                description: 'WordPress site URL (overrides WORDPRESS_SITE_URL env var)',
              },
              username: {
                type: 'string',
                description: 'WordPress username (overrides WORDPRESS_USERNAME env var)',
              },
              password: {
                type: 'string',
                description: 'WordPress password (overrides WORDPRESS_PASSWORD env var)',
              },
              title: {
                type: 'string',
                description: 'Post title',
              },
              content: {
                type: 'string',
                description: 'Post content',
              },
              status: {
                type: 'string',
                description: 'Post status (draft, publish, etc.)',
                default: 'draft',
              },
            },
            required: ['title', 'content'],
          },
        },
        {
          name: 'get_posts',
          description: 'Get WordPress posts',
          inputSchema: {
            type: 'object',
            properties: {
              siteUrl: {
                type: 'string',
                description: 'WordPress site URL (overrides WORDPRESS_SITE_URL env var)',
              },
              username: {
                type: 'string',
                description: 'WordPress username (overrides WORDPRESS_USERNAME env var)',
              },
              password: {
                type: 'string',
                description: 'WordPress password (overrides WORDPRESS_PASSWORD env var)',
              },
              perPage: {
                type: 'number',
                description: 'Number of posts per page',
                default: 10,
              },
              page: {
                type: 'number',
                description: 'Page number',
                default: 1,
              },
            },
          },
        },
        {
          name: 'update_post',
          description: 'Update an existing WordPress post',
          inputSchema: {
            type: 'object',
            properties: {
              siteUrl: {
                type: 'string',
                description: 'WordPress site URL (overrides WORDPRESS_SITE_URL env var)',
              },
              username: {
                type: 'string',
                description: 'WordPress username (overrides WORDPRESS_USERNAME env var)',
              },
              password: {
                type: 'string',
                description: 'WordPress password (overrides WORDPRESS_PASSWORD env var)',
              },
              postId: {
                type: 'number',
                description: 'Post ID to update',
              },
              title: {
                type: 'string',
                description: 'New post title',
              },
              content: {
                type: 'string',
                description: 'New post content',
              },
              status: {
                type: 'string',
                description: 'New post status (draft, publish, etc.)',
              },
            },
            required: ['postId'],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const method = request.params.name;
      const params = request.params.arguments;

      try {
        const result = await this.handleWordPressRequest(method, params);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }
        throw new McpError(
          ErrorCode.InternalError,
          error instanceof Error ? error.message : String(error)
        );
      }
    });
  }

  private async handleWordPressRequest(method: string, params: any): Promise<any> {
    try {
      const siteUrl = params.siteUrl || process.env.WORDPRESS_SITE_URL;
      const username = params.username || process.env.WORDPRESS_USERNAME;
      const password = params.password || process.env.WORDPRESS_PASSWORD;

      if (!siteUrl || !username || !password) {
        throw new McpError(
          ErrorCode.InvalidParams,
          'WordPress credentials not provided in environment variables or request parameters'
        );
      }

      const auth = Buffer.from(`${username}:${password}`).toString('base64');
      const client = axios.create({
        baseURL: `${siteUrl}/wp-json/wp/v2`,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
      });

      switch (method) {
        case 'create_post':
          if (!params.title || !params.content) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Title and content are required for creating a post'
            );
          }
          const createResponse = await client.post('/posts', {
            title: params.title,
            content: params.content,
            status: params.status || 'draft',
          });
          return createResponse.data;

        case 'get_posts':
          const getResponse = await client.get('/posts', {
            params: {
              per_page: params.perPage || 10,
              page: params.page || 1,
            },
          });
          return getResponse.data;

        case 'update_post':
          if (!params.postId) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Post ID is required for updating a post'
            );
          }
          const updateData: Record<string, any> = {};
          if (params.title) updateData.title = params.title;
          if (params.content) updateData.content = params.content;
          if (params.status) updateData.status = params.status;

          const updateResponse = await client.post(
            `/posts/${params.postId}`,
            updateData
          );
          return updateResponse.data;

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown method: ${method}`
          );
      }
    } catch (error: unknown) {
      if (isAxiosError(error)) {
        throw new McpError(
          ErrorCode.InternalError,
          `WordPress API error: ${
            error.response?.data?.message || error.message
          }`
        );
      }
      throw error;
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('WordPress MCP server running on stdin/stdout');
  }
}

const server = new WordPressServer();
server.run().catch(console.error);
