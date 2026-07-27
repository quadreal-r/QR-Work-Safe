import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.quadreal.worksafe',
  appName: 'Work Safe',
  webDir: 'www',
  server: {
    cleartext: true,
    androidScheme: 'https',
  },
};

export default config;
