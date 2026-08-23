function allowTestRuntime({ isPackaged, testMode }) {
  return !isPackaged && testMode === '1';
}

module.exports = { allowTestRuntime };
