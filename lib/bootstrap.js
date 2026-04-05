const db = require('./db');
const { hashPassphrase } = require('./passphrase');
const logger = require('./logger');

async function bootstrap() {
  logger.info('Starting bootstrap process...');

  try {
    // 1. Ensure owner exists (conceptually, the owner login is via OWNER_PASSPHRASE_HASH env var)
    // However, the user mentioned "creating the owner as well". 
    // In this app, owner is not a row in the members table, but we can verify env vars.
    if (!process.env.OWNER_PASSPHRASE_HASH) {
      logger.warn('OWNER_PASSPHRASE_HASH is missing in .env. Owner login will not work.');
    } else {
      logger.info('Owner passphrase hash is present.');
    }

    // 2. Create test member if it doesn't exist
    const testMemberEmail = 'test@example.com';
    const testMemberHandle = 'testmember';
    const testPassphrase = 'test-member-123';

    const { data: existingMember, error: checkError } = await db
      .from('members')
      .select('id')
      .eq('email', testMemberEmail)
      .maybeSingle();

    if (checkError) {
      logger.error('Error checking for test member', { error: checkError.message });
    } else if (!existingMember) {
      logger.info('Test member not found. Creating test member...');
      const hash = await hashPassphrase(testPassphrase);
      
      const { data: newMember, error: insertError } = await db
        .from('members')
        .insert({
          handle: testMemberHandle,
          email: testMemberEmail,
          passphrase_hash: hash,
          status: 'active',
          notify_drops: true
        })
        .select()
        .single();

      if (insertError) {
        logger.error('Failed to create test member', { error: insertError.message });
      } else {
        logger.info('Test member created successfully', { 
          handle: testMemberHandle, 
          email: testMemberEmail,
          passphrase: testPassphrase 
        });
      }
    } else {
      logger.info('Test member already exists. Skipping creation.');
    }

    logger.info('Bootstrap process completed.');
  } catch (err) {
    logger.error('Critical error during bootstrap', { error: err.message, stack: err.stack });
  }
}

module.exports = bootstrap;
