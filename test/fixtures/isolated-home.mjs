// Test-only substitute; never change HOME or scan actual user transcripts.
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
if (!process.env.LINUS_TEST_TRANSCRIPTS) throw new Error('Missing test fixture root');
os.homedir = () => process.env.LINUS_TEST_TRANSCRIPTS;
syncBuiltinESMExports();
