import dotenv from 'dotenv';

dotenv.config();

export function getGreeting(name: string): string {
  return `Hello, ${name}!`;
}

if (require.main === module) {
  console.log(getGreeting('SlackBot'));
}
