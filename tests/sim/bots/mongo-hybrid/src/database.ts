import mongoose from 'mongoose';
import { env } from './env';

export async function connectDatabase(clusterId: number) {
  mongoose.connection.on('error', (err) => console.error(`[Cluster ${clusterId}] MongoDB error: ${err.message}`));
  await mongoose.connect(env.DATABASE_URL, { appName: `helpdesk-cluster-${clusterId}`, serverSelectionTimeoutMS: 10_000 });
  console.log(`[Cluster ${clusterId}] Connected to MongoDB`);
}

export async function disconnectDatabase() {
  await mongoose.disconnect();
}
