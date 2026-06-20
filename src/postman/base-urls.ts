import type { PostmanRegion, PostmanStack } from '../types.js';

export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  cliInstallUrl: string;
}

const POSTMAN_ENDPOINT_PROFILES: Record<PostmanStack, PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    cliInstallUrl: 'https://dl-cli.pstmn.io/install/unix.sh'
  },
  beta: {
    apiBaseUrl: 'https://api.getpostman-beta.com',
    cliInstallUrl: 'https://dl-cli.pstmn-beta.io/install/unix.sh'
  }
};

export function parsePostmanRegion(value: string | undefined): PostmanRegion {
  const normalized = String(value || 'us').trim().toLowerCase();
  if (normalized === 'us' || normalized === 'eu') {
    return normalized;
  }
  throw new Error(`Unsupported postman-region "${value}". Supported values: us, eu`);
}

export function parsePostmanStack(value: string | undefined): PostmanStack {
  const normalized = String(value || 'prod').trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'beta') {
    return normalized;
  }
  throw new Error(`Unsupported postman-stack "${value}". Supported values: prod, beta`);
}

export function resolvePostmanEndpointProfile(
  stack: PostmanStack,
  region: PostmanRegion
): PostmanEndpointProfile {
  if (stack === 'beta' && region !== 'us') {
    throw new Error('postman-region=eu is only supported with postman-stack=prod');
  }
  const profile = POSTMAN_ENDPOINT_PROFILES[stack];
  return {
    ...profile,
    apiBaseUrl: region === 'eu' ? 'https://api.eu.postman.com' : profile.apiBaseUrl
  };
}
