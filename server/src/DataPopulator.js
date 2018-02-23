'use strict';

const Github = require('./Github');
const languages = require('./languages.json');
const Stackoverflow = require('./Stackoverflow');

module.exports = class DataPopulator {
  constructor(app, cb) {
    this._app = app;
    this._cb = cb;
    this._github = new Github();
    this._stackoverflow = new Stackoverflow();

    if (process.env.hasOwnProperty('GITHUB_API_KEY')) {
      this._github.apiKey = process.env.GITHUB_API_KEY;
    }
    if (process.env.hasOwnProperty('STACKOVERFLOW_API_KEY')) {
      this._stackoverflow.apiKey = process.env.STACKOVERFLOW_API_KEY;
    }
  }

  async populateAllLanguages() {
    let languagesFromGithub = await Github.getLanguageNames();

    for (let i = 0; i < languagesFromGithub.length; i++) {
      let languageName = languagesFromGithub[i];

      if (languages.hasOwnProperty(languageName)) {
        if (languages[languageName].include === true) {
          await this._addLanguage(languageName, languages[languageName].stackoverflowTag);
        }
      } else {
        console.log(`DEBUG: Language from Github not found in languages.json: ${languageName}`);
      }
    }
  }

  _addLanguage(languageName, stackoverflowTag) {
    return new Promise((resolve, reject) => {
      // Do an upsert in case stackoverflowTag changes
      this._app.models.language.upsertWithWhere(
        {name: languageName},
        {
          name: languageName,
          stackoverflowTag: stackoverflowTag,
        },
        // Oddly enough this only works if the validations are ignored
        // https://github.com/strongloop/loopback-component-passport/issues/123#issue-131073519
        {validate: false},
        (err, language) => {
          if (err) reject(err);
          resolve();
        }
      );
    });
  }

  async populateTopScores() {
    const FIRST_DATE = new Date(Date.UTC(2007, 9)); // 2007-10-01 00:00:00 UTC
    const NUM_LANGUAGES = 10;
    let date = DataPopulator._getFirstDayOfMonth();

    let topLanguages = await this._getTopLanguages(NUM_LANGUAGES, date);

    // TODO
    console.log(topLanguages);

    // TODO make this code clearer
    for (let i = 0; date >= FIRST_DATE; i++) {
      date.setUTCMonth(date.getUTCMonth() - 1);
      // TODO
      console.log(`${i}: ${date}`);

      await this._populateScores(date, topLanguages);

      // Tell the app we're ready after the most recent year's scores are populated
      if (i === 10) {
        // TODO
        return;
        process.nextTick(this._cb);
      }
    }
  }

  static _getFirstDayOfMonth() {
    // Note this will return a date at 00:00:00 UTC time
    return new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth()));
  }

  async _getTopLanguages(numberOfLanguages, date) {
    let scoreCount = await this._getScoreCount(date);
    let topLanguages = [];

    if (scoreCount < numberOfLanguages) {
      topLanguages = await this._getTopLanguagesFromApi(numberOfLanguages, date);
    } else {
      topLanguages = await this._getTopLanguagesFromDb(numberOfLanguages, date);
    }

    return topLanguages;
  }

  _getScoreCount(date) {
    return new Promise((resolve, reject) => {
      this._app.models.score.count({date: date}, (err, count) => {
        if (err) reject(err);
        resolve(count);
      });
    });
  }

  _getTopLanguagesFromApi(numberOfLanguages, date) {
    return new Promise(async (resolve, reject) => {
      let promises = [];
      let scores = await this._getAllScores(date);
      let topLanguages = DataPopulator._getTopItems(scores, numberOfLanguages);

      for (let i = 0; i < topLanguages.length; i++) {
        let languageName = topLanguages[i];
        promises.push(this._addScore(date, languageName, scores[languageName]));
      }

      Promise.all(promises).then(
        values => { resolve(topLanguages); },
        reason => { reject(reason); }
      );
    });
  }

  async _getAllScores(date) {
    let languages = await this._getAllLanguages();
    let scores = {};

    while (languages.length !== 0) {
      Object.assign(scores, await this._getScores(date, languages.splice(0, Stackoverflow.MAX_REQUESTS_PER_SECOND)));
    }

    return scores;
  }

  _getScores(date, languages) {
    return new Promise((resolve, reject) => {
      let promises = [];
      let scores = {};

      for (let i = 0; i < languages.length; i++) {
        let languageName = languages[i].name;
        promises.push(
          this._getScore(date, languageName).then((score, reason) => {
            if (reason) reject(reason);
            scores[languageName] = score;
          })
        );
      }

      Promise.all(promises).then(
        values => { resolve(scores); },
        reason => { reject(reason); }
      );
    });
  }

  async _getScore(date, languageName) {
    let githubScore = await this._github.getScore(languageName, date);
    let stackoverflowTag = await this._getStackoverflowTag(languageName);
    let stackoverflowScore = await this._stackoverflow.getScore(stackoverflowTag, date);
    if (stackoverflowScore === 0) {
      console.log(`WARNING: stackoverflow tag not found for ${languageName}`);
    }

    return githubScore + stackoverflowScore;
  }

  _getStackoverflowTag(languageName) {
    return new Promise((resolve, reject) => {
      this._app.models.language.findOne({where: {name: languageName}}, (err, language) => {
        if (err) throw err;

        if (language !== null) {
          if (typeof language.stackoverflowTag === 'undefined') {
            resolve(languageName);
          } else {
            resolve(language.stackoverflowTag);
          }
        } else {
          reject(`Language ${languageName} not found`);
        }
      });
    });
  }

  _getAllLanguages() {
    return new Promise((resolve, reject) => {
      this._app.models.language.all((err, languages) => {
        if (err) throw err;

        if (languages === null) {
          reject('Languages must be populated before scores can be populated');
        }

        resolve(languages);
      });
    });
  }

  static _getTopItems(obj, numberOfItems) {
    // https://stackoverflow.com/a/39442287/399105
    let sortedKeys = Object.keys(obj).sort((a, b) => obj[b] - obj[a]);

    return sortedKeys.splice(0, numberOfItems);
  }

  _addScore(date, languageName, points) {
    return new Promise((resolve, reject) => {
      this._app.models.language.findOne({where: {name: languageName}}, (err, language) => {
        if (err) reject(err);

        if (language !== null) {
          // Do an upsert because we don't want duplicate scores per date/language
          this._app.models.score.upsertWithWhere(
            {
              date: date,
              languageId: language.id,
            },
            {
              date: date,
              language: language,
              points: points,
            },
            (err, score) => {
              if (err) reject(err);
            }
          );
        } else {
          reject(`Language ${languageName} not found`);
        }
        resolve();
      });
    });
  }

  _getTopLanguagesFromDb(numberOfLanguages, date) {
    return new Promise((resolve, reject) => {
      this._app.models.score.find(
        {
          fields: {languageId: true},
          include: 'language',
          limit: numberOfLanguages,
          order: 'points DESC',
          where: {date: date},
        },
        (err, scores) => {
          if (err) throw err;

          if (scores === null) {
            reject(`No scores found for date: ${date}`);
          }

          // Apparently score.language is a function
          resolve(scores.map(score => score.language().name));
        }
      );
    });
  }

  _populateScores(date, languages) {
    return new Promise((resolve, reject) => {
      let promises = [];

      for (let i = 0; i < languages.length; i++) {
        promises.push(this._populateScore(date, languages[i]));
      }

      Promise.all(promises).then(
        values => { resolve(); },
        reason => { reject(reason); }
      );
    });
  }

  _populateScore(date, languageName) {
    return new Promise((resolve, reject) => {
      this._app.models.language.findOne({where: {name: languageName}}, (err, language) => {
        if (err) throw err;

        if (language !== null) {
          this._app.models.score.findOne(
            {
              where: {
                date: date,
                languageId: language.id,
              },
            },
            async (err, score) => {
              if (err) reject(err);
              if (score === null) {
                let points = await this._getScore(date, languageName);
                await this._addScore(date, languageName, points);
              }
              resolve();
            }
          );
        } else {
          reject(`Language ${languageName} not found`);
        }
      });
    });
  }
};
