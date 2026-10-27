module.exports = class NativeSqliteDisabled {
  constructor() {
    throw new Error('master-agent는 node:sqlite 어댑터만 사용합니다.');
  }
};
