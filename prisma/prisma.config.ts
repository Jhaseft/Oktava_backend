import "dotenv/config";

export default {
  datasources: {
    db: process.env.DATABASE_URL,
  },
};
