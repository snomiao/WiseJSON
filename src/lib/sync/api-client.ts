import http from 'http';
import { OutgoingHttpHeaders } from 'http2';
import https from 'https';
import { URL } from 'url';
import { ApiEndpoints } from '../types.js';

/**
 * Custom error class for API-related failures, including the HTTP status code.
 */
export class ApiError extends Error {
    public statusCode?: number;
    constructor(message: string, statusCode?: number) {
        super(message);
        this.name = 'ApiError';
        this.statusCode = statusCode;
    }
}

/**
 * Low-level client for communicating with a remote WiseJSON server.
 * Uses native Node.js modules to minimize external dependencies and overhead.
 */
export class ApiClient {
    private readonly baseUrl: URL;
    private readonly apiKey: string;
    private readonly agent: typeof http | typeof https;
    public readonly endpoints: ApiEndpoints;

    /**
     * @param baseUrl - The full base URL of the server (e.g., 'https://api.wisejson.io').
     * @param apiKey - Authentication token.
     * @param endpoints - Optional custom paths for sync operations.
     */
    constructor(baseUrl: string, apiKey: string, endpoints: Partial<ApiEndpoints> = {}) {
        if (!baseUrl || !apiKey) {
            throw new Error('ApiClient requires baseUrl and apiKey for initialization.');
        }

        try {
            this.baseUrl = new URL(baseUrl);
        } catch (err) {
            throw new Error(`Invalid baseUrl provided: ${baseUrl}`);
        }

        this.apiKey = apiKey;
        this.agent = this.baseUrl.protocol === 'https:' ? https : http;

        // IMPROVEMENT: Making endpoints configurable
        this.endpoints = {
            snapshot: '/sync/snapshot',
            pull: '/sync/pull',
            push: '/sync/push',
            health: '/sync/health',
            ...endpoints,
        };
    }

    /**
     * Internal core method for executing HTTP requests.
     * @param method - HTTP Verb (GET, POST, etc.).
     * @param path - The specific endpoint path.
     * @param body - Optional JSON payload for the request.
     */
    private _request<T = any>(method: string, path: string, body: any = null): Promise<T> {
        return new Promise((resolve, reject) => {
            // Safely join base pathname and request path
            const baseStr = this.baseUrl.pathname.endsWith('/')
                ? this.baseUrl.pathname.slice(0, -1)
                : this.baseUrl.pathname;

            const fullPath = `${baseStr}${path}`;

            const options: https.RequestOptions = {
                hostname: this.baseUrl.hostname,
                port: this.baseUrl.port || (this.baseUrl.protocol === 'https:' ? 443 : 80),
                path: fullPath,
                method: method.toUpperCase(),
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`,
                },
                timeout: 15000, // 15-second timeout for requests
            };

            if (body) {
              (options.headers as OutgoingHttpHeaders)['Content-Type'] = 'application/json';
            }

            const req = this.agent.request(options, (res) => {
                let responseData = '';
                res.setEncoding('utf8');

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    // Handle HTTP error statuses
                    if (res.statusCode && res.statusCode >= 400) {
                        let errorMessage: string;
                        try {
                            const errorPayload = JSON.parse(responseData);
                            errorMessage = errorPayload.error || `Server returned ${res.statusCode}`;
                        } catch {
                            errorMessage = `Server returned ${res.statusCode}: ${responseData.substring(0, 100)}`;
                        }
                        return reject(new ApiError(errorMessage, res.statusCode));
                    }

                    // Handle successful empty responses (e.g., 204 No Content)
                    if (res.statusCode === 204 || !responseData) {
                        return resolve(null as any);
                    }

                    try {
                        const parsedData = JSON.parse(responseData);
                        resolve(parsedData);
                    } catch (e) {
                        reject(new Error(`Failed to parse JSON response. Raw: ${responseData.substring(0, 100)}`));
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timed out after 15 seconds.'));
            });

            req.on('error', (e) => {
                reject(new Error(`Network error: ${e.message}`));
            });

            if (body) {
                try {
                    req.write(JSON.stringify(body));
                } catch (e: any) {
                    return reject(new Error(`Serialization error: ${e.message}`));
                }
            }

            req.end();
        });
    }

    /**
     * Performs a type-safe GET request.
     * @param path - The target path.
     */
    public async get<T = any>(path: string): Promise<T> {
        return this._request<T>('GET', path);
    }

    /**
     * Performs a type-safe POST request.
     * @param path - The target path.
     * @param body - The object to be sent as JSON.
     */
    public async post<T = any>(path: string, body: any): Promise<T> {
        return this._request<T>('POST', path, body);
    }
}
