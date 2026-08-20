import mongoose from 'mongoose';
import { env } from './src/config/env.js';
import { User } from './src/models/User.js';
import { Business } from './src/models/Business.js';
import { Subscription } from './src/models/Subscription.js';
import { Payment } from './src/models/Payment.js';

await mongoose.connect(env.mongoUri);
const admin = await User.findOne({ email: 'admin@demo.com' });
const bizs = await Business.find({ owner: admin._id });
console.log('Admin _id:', admin._id.toString());
console.log('Negocios del admin:', bizs.length);
for (const b of bizs) {
  const sub = await Subscription.findOne({ business: b._id }).populate('plan');
  console.log(' -', b.name, '| _id:', b._id.toString(), '| plan:', sub?.plan?.key, '| status:', sub?.status);
}
const pays = await Payment.find({ user: admin._id });
console.log('Pagos del admin:', pays.length, pays.map(p=>p.description));
await mongoose.disconnect();
