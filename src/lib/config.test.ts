import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { required, optionalInt, clientId, createConfig } from './config';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset process.env to original state before each test
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    });
    Object.keys(originalEnv).forEach((key) => {
      process.env[key] = originalEnv[key];
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // required() tests
  it('should throw when REDIS_HOST is missing', () => {
    delete process.env.REDIS_HOST;
    expect(() => required('REDIS_HOST')).toThrow(
      'Missing required environment variable: REDIS_HOST'
    );
  });

  it('should return value when environment variable is set', () => {
    process.env.REDIS_HOST = 'localhost';
    expect(required('REDIS_HOST')).toBe('localhost');
  });

  // optionalInt() tests
  it('should return default when environment variable is not set', () => {
    delete process.env.NONEXISTENT;
    expect(optionalInt('NONEXISTENT', 42)).toBe(42);
  });

  it('should throw when value is not a valid integer', () => {
    process.env.REDIS_PORT = 'abc';
    expect(() => optionalInt('REDIS_PORT', 6379)).toThrow('REDIS_PORT must be an integer');
  });

  it('should throw when value is below minimum', () => {
    process.env.API_TIMEOUT_MS = '500';
    expect(() => optionalInt('API_TIMEOUT_MS', 20_000, { min: 1_000 })).toThrow('must be >= 1000');
  });

  it('should throw when value exceeds maximum', () => {
    process.env.API_TIMEOUT_MS = '26000';
    expect(() => optionalInt('API_TIMEOUT_MS', 20_000, { max: 25_000 })).toThrow(
      'must be <= 25000'
    );
  });

  it('should parse and return valid integer', () => {
    process.env.REDIS_PORT = '6380';
    expect(optionalInt('REDIS_PORT', 6379)).toBe(6380);
  });

  // clientId() tests
  it('should throw when CLIENT_ID is missing', () => {
    delete process.env.CLIENT_ID;
    expect(() => clientId('CLIENT_ID')).toThrow('Missing required environment variable: CLIENT_ID');
  });

  it('should throw when CLIENT_ID is not in enum', () => {
    process.env.CLIENT_ID = 'cms_web';
    expect(() => clientId('CLIENT_ID')).toThrow('is not a valid client_id');
  });

  it('should return valid CLIENT_ID', () => {
    process.env.CLIENT_ID = 'cms-web';
    expect(clientId('CLIENT_ID')).toBe('cms-web');
  });

  it('should accept all valid CLIENT_IDs', () => {
    const validIds = ['cms-web', 'public-web', 'ios-app', 'android-app'];
    validIds.forEach((id) => {
      process.env.CLIENT_ID = id;
      expect(clientId('CLIENT_ID')).toBe(id);
    });
  });

  // createConfig() integration tests
  describe('createConfig()', () => {
    beforeEach(() => {
      // Set required environment variables
      process.env.REDIS_HOST = 'localhost';
      process.env.API_BASE_URL = 'http://localhost:8080';
      process.env.PUBLIC_ORIGIN = 'http://localhost:3000';
      process.env.CLIENT_ID = 'cms-web';
    });

    it('should default API_BASE_PATH to /api/v1 when not set', () => {
      delete process.env.API_BASE_PATH;
      const config = createConfig();
      expect(config.api.basePath).toBe('/api/v1');
    });

    it('should default CMS_API_BASE_PATH to /api when not set', () => {
      delete process.env.CMS_API_BASE_PATH;
      const config = createConfig();
      expect(config.api.cmsBasePath).toBe('/api');
    });

    it('should strip trailing slash from API_BASE_URL and API_BASE_PATH to avoid // collisions', () => {
      process.env.API_BASE_URL = 'http://localhost:8080/';
      process.env.API_BASE_PATH = '/api/v1/';
      const config = createConfig();
      expect(config.api.baseUrl).toBe('http://localhost:8080');
      expect(config.api.basePath).toBe('/api/v1');
    });

    it('should strip trailing slash from CMS_API_BASE_PATH to avoid // collisions', () => {
      process.env.CMS_API_BASE_PATH = '/api/';
      const config = createConfig();
      expect(config.api.cmsBasePath).toBe('/api');
    });

    it('should use default values for all optional variables', () => {
      delete process.env.REDIS_PORT;
      delete process.env.REDIS_PASSWORD;
      delete process.env.REDIS_DB;
      delete process.env.API_BASE_PATH;
      delete process.env.CMS_API_BASE_PATH;
      delete process.env.API_TIMEOUT_MS;
      delete process.env.SESSION_TTL_SECONDS;
      delete process.env.REFRESH_THRESHOLD_SECONDS;
      delete process.env.REFRESH_LOCK_TTL_SECONDS;
      delete process.env.COOKIE_DOMAIN;
      delete process.env.ALLOWED_ORIGINS_EXTRA;

      const config = createConfig();
      expect(config.redis.port).toBe(6379);
      expect(config.redis.password).toBeUndefined();
      expect(config.redis.db).toBe(0);
      expect(config.api.basePath).toBe('/api/v1');
      expect(config.api.cmsBasePath).toBe('/api');
      expect(config.api.timeoutMs).toBe(20_000);
      expect(config.session.ttlSeconds).toBe(28800);
      expect(config.session.refreshThresholdSeconds).toBe(180);
      expect(config.session.refreshLockTtlSeconds).toBe(10);
      expect(config.session.cookieDomain).toBeUndefined();
    });

    it('should set isProd to true when NODE_ENV is production', () => {
      (process.env as Record<string, string>).NODE_ENV = 'production';
      const config = createConfig();
      expect(config.isProd).toBe(true);
    });

    it('should set isProd to false when NODE_ENV is development', () => {
      (process.env as Record<string, string>).NODE_ENV = 'development';
      const config = createConfig();
      expect(config.isProd).toBe(false);
    });

    it('should parse ALLOWED_ORIGINS_EXTRA into the allowedOrigins set', () => {
      process.env.ALLOWED_ORIGINS_EXTRA = 'https://api.example.com,https://app.example.com';
      const config = createConfig();
      expect(config.app.allowedOrigins.has('https://api.example.com')).toBe(true);
      expect(config.app.allowedOrigins.has('https://app.example.com')).toBe(true);
    });

    it('should always include PUBLIC_ORIGIN in allowedOrigins regardless of ALLOWED_ORIGINS_EXTRA', () => {
      process.env.ALLOWED_ORIGINS_EXTRA = 'https://api.example.com';
      const config = createConfig();
      expect(config.app.allowedOrigins.has('http://localhost:3000')).toBe(true);
    });

    it('should ignore empty entries and trim whitespace in ALLOWED_ORIGINS_EXTRA', () => {
      process.env.ALLOWED_ORIGINS_EXTRA =
        '  https://api.example.com  , , https://app.example.com  ';
      const config = createConfig();
      expect(config.app.allowedOrigins.has('https://api.example.com')).toBe(true);
      expect(config.app.allowedOrigins.has('https://app.example.com')).toBe(true);
      expect(config.app.allowedOrigins.size).toBe(3); // PUBLIC_ORIGIN + 2 from ALLOWED_ORIGINS_EXTRA
    });

    it('should throw when API_TIMEOUT_MS exceeds 25000', () => {
      process.env.API_TIMEOUT_MS = '26000';
      expect(() => createConfig()).toThrow('must be <= 25000');
    });

    it('should throw when API_TIMEOUT_MS is below 1000', () => {
      process.env.API_TIMEOUT_MS = '500';
      expect(() => createConfig()).toThrow('must be >= 1000');
    });
  });
});
