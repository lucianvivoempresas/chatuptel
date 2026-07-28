import { ServerOptions } from './types/ServerOptions';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
};

export default {
  secretKey: required('WPP_SECRET_KEY'),
  host: 'http://wppconnect',
  port: '21465',
  deviceName: process.env.WPP_DEVICE_NAME || 'Volt Conect Atendimento',
  poweredBy: 'Volt Conect',
  startAllSession: false,
  tokenStoreType: 'file',
  maxListeners: 15,
  customUserDataDir: './userDataDir/',
  webhook: {
    url: null,
    autoDownload: true,
    uploadS3: false,
    readMessage: true,
    allUnreadOnStart: false,
    listenAcks: true,
    onPresenceChanged: false,
    onParticipantsChanged: false,
    onReactionMessage: true,
    onPollResponse: false,
    onRevokedMessage: true,
    onLabelUpdated: false,
    onSelfMessage: false,
    ignore: ['status@broadcast'],
  },
  websocket: {
    autoDownload: false,
    uploadS3: false,
  },
  chatwoot: {
    sendQrCode: true,
    sendStatus: true,
  },
  archive: {
    enable: false,
    waitTime: 10,
    daysToArchive: 45,
  },
  log: {
    level: 'info',
    logger: ['console', 'file'],
  },
  createOptions: {
    browserArgs: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--no-first-run',
    ],
    linkPreviewApiServers: null,
  },
  mapper: {
    enable: false,
    prefix: 'voltconect-',
  },
  db: {
    mongodbDatabase: 'tokens',
    mongodbCollection: '',
    mongodbUser: '',
    mongodbPassword: '',
    mongodbHost: '',
    mongoIsRemote: true,
    mongoURLRemote: '',
    mongodbPort: 27017,
    redisHost: 'redis',
    redisPort: 6379,
    redisPassword: '',
    redisDb: 0,
    redisPrefix: 'voltconect',
  },
  aws_s3: {
    region: 'sa-east-1' as any,
    access_key_id: null,
    secret_key: null,
    defaultBucketName: null,
    endpoint: null,
    forcePathStyle: null,
  },
} as unknown as ServerOptions;

