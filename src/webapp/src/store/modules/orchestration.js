import Vue from 'vue'

import lodash from 'lodash'

import orchestrationsApi from '@/api/orchestrations'
import poller from '@/utils/poller'
import utils from '@/utils/utils'

const defaultState = utils.deepFreeze({
  pluginInFocusConfiguration: {},
  pipelinePollers: [],
  pipelines: [],
  pipeline: {}
})

const getters = {
  getHasPipelines(state) {
    return state.pipelines.length > 0
  },

  getHasPipelineWithPlugin(_, getters) {
    return (pluginType, pluginName) =>
      Boolean(getters.getPipelineWithPlugin(pluginType, pluginName))
  },

  getHasValidConfigSettings(_, getters) {
    return (configSettings, settingsGroupValidation = null) => {
      return settingsGroupValidation && settingsGroupValidation.length
        ? getters.getHasGroupValidationConfigSettings(
            configSettings,
            settingsGroupValidation
          )
        : getters.getHasDefaultValidationConfigSettings(configSettings)
    }
  },

  getHasDefaultValidationConfigSettings() {
    return configSettings => {
      const isKindBoolean = setting =>
        setting.kind && setting.kind === 'boolean'
      const isValid = setting =>
        isKindBoolean(setting) || Boolean(configSettings.config[setting.name])
      return (
        configSettings.settings &&
        lodash.every(configSettings.settings, isValid)
      )
    }
  },

  getHasGroupValidationConfigSettings() {
    return (configSettings, settingsGroupValidation) => {
      const matchGroup = settingsGroupValidation.find(group => {
        if (configSettings.settings) {
          const groupedSettings = configSettings.settings.filter(setting =>
            group.includes(setting.name)
          )
          const isValid = setting =>
            Boolean(configSettings.config[setting.name])
          return lodash.every(groupedSettings, isValid)
        }
      })
      return configSettings.settings && Boolean(matchGroup)
    }
  },

  getPipelineWithPlugin(state) {
    return (pluginType, pluginName) =>
      state.pipelines.find(pipeline => pipeline[pluginType] === pluginName)
  },

  getPipelinesWithPlugin(state) {
    return (pluginType, pluginName) =>
      state.pipelines.filter(pipeline => pipeline[pluginType] === pluginName)
  },

  getRunningPipelines(state) {
    return state.pipelines.filter(pipeline => pipeline.isRunning)
  },

  getRunningPipelineJobIds(state) {
    return state.pipelinePollers.map(
      pipelinePoller => pipelinePoller.getMetadata().jobId
    )
  },

  getActivePipeline(state) {
    return state.pipeline
  },

  getSortedPipelines(state) {
    return lodash.orderBy(state.pipelines, 'extractor')
  },

  getSuccessfulPipelines(state) {
    return state.pipelines.filter(pipeline => pipeline.hasEverSucceeded)
  },

  lastUpdatedDate(_, getters) {
    return extractor => {
      const pipelineExtractor = getters.getPipelineWithPlugin(
        'extractor',
        extractor
      )

      if (!pipelineExtractor) {
        return ''
      }

      return pipelineExtractor.endedAt
        ? utils.formatDateStringYYYYMMDD(pipelineExtractor.endedAt)
        : pipelineExtractor.isRunning
        ? 'Updating...'
        : ''
    }
  },

  startDate(_, getters) {
    return extractor => {
      const pipelineExtractor = getters.getPipelineWithPlugin(
        'extractor',
        extractor
      )

      return pipelineExtractor ? pipelineExtractor.startDate : ''
    }
  }
}

const actions = {
  createSubscription(_, subscription) {
    return orchestrationsApi.createSubscription(subscription)
  },

  deletePipelineSchedule({ commit }, pipeline) {
    let status = {
      pipeline,
      ...pipeline,
      isDeleting: true
    }
    commit('setPipelineStatus', status)
    return orchestrationsApi.deletePipelineSchedule(pipeline).then(() => {
      commit('deletePipeline', pipeline)
    })
  },

  getPipelineByJobId({ commit, state }, jobId) {
    return new Promise(resolve => {
      try {
        if (state.pipelines.length > 0) {
          let pipeline = state.pipelines.find(
            pipeline => pipeline.jobId === jobId
          )
          commit('setActivePipeline', pipeline)
          resolve()
        }
      } catch (error) {
        console.log('Error: ', error)
      }
    })
  },

  getJobLog(_, jobId) {
    return orchestrationsApi.getJobLog({ jobId })
  },

  getLoaderConfiguration({ commit, dispatch }, loader) {
    return dispatch('getPluginConfiguration', {
      name: loader,
      type: 'loaders'
    }).then(response => {
      commit('setInFocusConfiguration', {
        configuration: response.data,
        target: 'loaderInFocusConfiguration'
      })
    })
  },

  getPipelineSchedules({ commit, dispatch }) {
    return orchestrationsApi.getPipelineSchedules().then(response => {
      commit('setPipelines', response.data)
      dispatch('rehydratePollers')
    })
  },

  getPluginConfiguration(_, pluginPayload) {
    return orchestrationsApi.getPluginConfiguration(pluginPayload)
  },

  getAndFocusOnPluginConfiguration({ commit, dispatch, state }, payload) {
    return dispatch('getPluginConfiguration', payload).then(response => {
      commit('setInFocusConfiguration', {
        configuration: response.data,
        target: 'pluginInFocusConfiguration'
      })
      return state.pluginInFocusConfiguration
    })
  },

  getPolledPipelineJobStatus({ commit, getters, state }) {
    return orchestrationsApi
      .getPolledPipelineJobStatus({ jobIds: getters.getRunningPipelineJobIds })
      .then(response => {
        response.data.jobs.forEach(jobStatus => {
          const targetPoller = state.pipelinePollers.find(
            pipelinePoller =>
              pipelinePoller.getMetadata().jobId === jobStatus.jobId
          )
          if (jobStatus.isComplete) {
            commit('removePipelinePoller', targetPoller)
          }

          const targetPipeline = state.pipelines.find(
            pipeline => pipeline.name === jobStatus.jobId
          )

          commit('setPipelineStatus', {
            pipeline: targetPipeline,
            ...targetPipeline,
            hasError: jobStatus.hasError,
            hasEverSucceeded: jobStatus.hasEverSucceeded,
            isRunning: !jobStatus.isComplete,
            startedAt: jobStatus.startedAt,
            endedAt: jobStatus.endedAt
          })
        })
      })
  },

  queuePipelinePoller({ commit, dispatch }, pollMetadata) {
    const pollFn = () => dispatch('getPolledPipelineJobStatus')
    const pipelinePoller = poller.create(pollFn, pollMetadata, 8000)
    pipelinePoller.init()
    commit('addPipelinePoller', pipelinePoller)
  },

  rehydratePollers({ dispatch, getters, state }) {
    // Handle page refresh condition resulting in jobs running but no pollers
    const pollersUponQueued = getters.getRunningPipelines.map(pipeline => {
      const jobId = pipeline.name
      const isMissingPoller =
        state.pipelinePollers.find(
          pipelinePoller => pipelinePoller.getMetadata().jobId === jobId
        ) === undefined

      if (isMissingPoller) {
        return dispatch('queuePipelinePoller', { jobId })
      }
    })

    return Promise.all(pollersUponQueued)
  },

  resetPluginInFocusConfiguration: ({ commit }) =>
    commit('reset', 'pluginInFocusConfiguration'),

  run({ commit, dispatch }, pipeline) {
    commit('setPipelineStatus', {
      pipeline,
      ...pipeline,
      isRunning: true
    })

    return orchestrationsApi.run({ name: pipeline.name }).then(response => {
      dispatch('queuePipelinePoller', response.data)
    })
  },

  savePipelineSchedule({ commit }, { pipeline }) {
    return orchestrationsApi.savePipelineSchedule(pipeline).then(response => {
      const newPipeline = Object.assign(pipeline, response.data)
      commit('updatePipelines', newPipeline)
    })
  },

  savePluginConfiguration(_, configPayload) {
    return orchestrationsApi.savePluginConfiguration(configPayload)
  },

  testPluginConfiguration(_, configPayload) {
    return orchestrationsApi.testPluginConfiguration(configPayload)
  },

  updatePipelineSchedule({ commit }, payload) {
    console.log('payload', payload)
    commit('setPipelineStatus', {
      pipeline: payload.pipeline,
      ...payload.pipeline,
      isSaving: true
    })
    return orchestrationsApi.updatePipelineSchedule(payload).then(response => {
      // const updatedPipeline = { ...response.data, ...payload.pipeline }
      const updatedPipeline = Object.assign({}, payload.pipeline, response.data)
      console.log('response', response.data)
      console.log('pipeline', updatedPipeline)
      commit('setPipelineStatus', {
        pipeline: updatedPipeline,
        ...updatedPipeline,
        isSaving: false
      })
      commit('setPipeline', updatedPipeline)
    })
  },

  uploadPluginConfigurationFile(_, payload) {
    return orchestrationsApi.uploadPluginConfigurationFile(payload)
  },

  deleteUploadedPluginConfigurationFile(_, payload) {
    return orchestrationsApi.deleteUploadedPluginConfigurationFile(payload)
  }
}

const mutations = {
  addPipelinePoller(state, pipelinePoller) {
    state.pipelinePollers.push(pipelinePoller)
  },

  deletePipeline(state, pipeline) {
    const idx = state.pipelines.indexOf(pipeline)
    Vue.delete(state.pipelines, idx)
  },

  removePipelinePoller(state, pipelinePoller) {
    pipelinePoller.dispose()
    const idx = state.pipelinePollers.indexOf(pipelinePoller)
    Vue.delete(state.pipelinePollers, idx)
  },

  reset(state, attr) {
    if (defaultState.hasOwnProperty(attr)) {
      state[attr] = lodash.cloneDeep(defaultState[attr])
    }
  },

  setActivePipeline(state, pipeline) {
    state.pipeline = pipeline
  },

  setInFocusConfiguration(state, { configuration, target }) {
    const requiredSettingsKeys = utils.requiredConnectorSettingsKeys(
      configuration.settings,
      configuration.settingsGroupValidation
    )
    configuration.settings.forEach(setting => {
      const isIso8601Date = setting.kind && setting.kind === 'date_iso8601'
      const isDefaultNeeded =
        configuration.config.hasOwnProperty(setting.name) &&
        configuration.config[setting.name] === null &&
        requiredSettingsKeys.includes(setting.name)
      if (isIso8601Date && isDefaultNeeded) {
        configuration.config[setting.name] = utils.getFirstOfMonthAsYYYYMMDD()
      }
    })
    state[target] = configuration
  },

  setPipeline(state, pipeline) {
    const target = state.pipelines.find(p => p.name === pipeline.name)
    const idx = state.pipelines.indexOf(target)
    Vue.set(state.pipelines, idx, pipeline)
  },

  setPipelineStatus(
    _,
    {
      pipeline,
      hasError,
      hasEverSucceeded,
      isDeleting,
      isRunning,
      isSaving,
      startedAt = null,
      endedAt = null
    }
  ) {
    Vue.set(pipeline, 'hasError', hasError || false)
    Vue.set(pipeline, 'hasEverSucceeded', hasEverSucceeded || false)
    Vue.set(pipeline, 'isDeleting', isDeleting || false)
    Vue.set(pipeline, 'isRunning', isRunning || false)
    Vue.set(pipeline, 'isSaving', isSaving || false)
    Vue.set(pipeline, 'startedAt', utils.dateIso8601Nullable(startedAt))
    Vue.set(pipeline, 'endedAt', utils.dateIso8601Nullable(endedAt))
  },

  setPipelines(state, pipelines) {
    pipelines.forEach(pipeline => {
      if (pipeline.startedAt) {
        pipeline.startedAt = utils.dateIso8601Nullable(pipeline.startedAt)
      }
      if (pipeline.endedAt) {
        pipeline.endedAt = utils.dateIso8601Nullable(pipeline.endedAt)
      }
    })
    state.pipelines = pipelines
  },

  toggleSelected(state, selectable) {
    Vue.set(selectable, 'selected', !selectable.selected)
  },

  updatePipelines(state, pipeline) {
    state.pipelines.push(pipeline)
  }
}

export default {
  namespaced: true,
  state: lodash.cloneDeep(defaultState),
  getters,
  actions,
  mutations
}
