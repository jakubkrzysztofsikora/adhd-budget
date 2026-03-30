export interface Config {
  port: number;
  host: string;
  aspspName: string;
  aspspCountry: string;
  externalUrl: string;
  enableAppId: string;
  enablePrivateKeyPath: string;
  enableApiBaseUrl: string;
  dataDir: string;
}

export function getConfig(): Config {
  return {
    port: parseInt(process.env.PORT || '8081', 10),
    host: process.env.HOST || '0.0.0.0',
    aspspName: process.env.ASPSP_NAME || 'MOCKASPSP_SANDBOX',
    aspspCountry: process.env.ASPSP_COUNTRY || 'FI',
    externalUrl: process.env.EXTERNAL_URL || `http://localhost:${process.env.PORT || '8081'}`,
    enableAppId: process.env.ENABLE_APP_ID || '',
    enablePrivateKeyPath: process.env.ENABLE_PRIVATE_KEY_PATH || '',
    enableApiBaseUrl: process.env.ENABLE_API_BASE_URL || 'https://api.enablebanking.com',
    dataDir: process.env.DATA_DIR || './data',
  };
}
