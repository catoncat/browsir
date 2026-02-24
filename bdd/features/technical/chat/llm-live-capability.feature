@contract(BHV-LLM-LIVE-CAPABILITY)
Feature: Real LLM capability smoke gate

  Scenario: 真实 LLM 对浏览器任务达到最低成功率
    Given sidepanel 配置真实 LLM endpoint 与 key
    When 系统执行多次浏览器任务冒烟并记录每次验证结果
    Then 任务成功率应达到门禁阈值
    And 失败样本应保留在 e2e evidence 以便回归分析
