import dotenv from 'dotenv';
import { createSlackApp } from './slack/app';

// Load environment variables from .env file
dotenv.config();

export function getGreeting(name: string): string {
  return `Hello, ${name}!`;
}

export async function startServer() {
  const { app } = createSlackApp();
  const port = Number(process.env.PORT) || 3000;
  const isSocketMode = process.env.SLACK_SOCKET_MODE === 'true';

  if (isSocketMode) {
    await app.start();
    console.log('⚡️ Bolt app is running in Socket Mode!');
  } else {
    await app.start(port);
    console.log(`⚡️ Bolt app is running in HTTP mode on port ${port}!`);
  }
}

// Start the server if executed directly
if (require.main === module) {
  startServer().catch((error) => {
    console.error('Failed to start SlackBot application:', error);
    process.exit(1);
  });
}
