const
  path = require('path'),
  FakeDataLoader = require('./dataLoader/FakeDataLoader'),
  sgUtil = require('./util');

class CollectorStore {
  constructor({conf}) {
    this.globOptions = conf.get('globOptions');
    this.htmlExt = conf.get('htmlExt');
    this.dataExt = conf.get('dataExt');
    this.c = conf.get('logLevel', 0);
    this.sectionOrder = conf.get('sections').map(({title}) => title);

    this.sections = new Map();
    this.files = new Map();

    this.setSection = this.setSection.bind(this);
    this.setFile = this.setFile.bind(this);
    this.unsetFile = this.unsetFile.bind(this);
    this.updateTimestamp = this.updateTimestamp.bind(this);
    this.setGroupedFile = this.setGroupedFile.bind(this);
    this.unsetGroupedFile = this.unsetGroupedFile.bind(this);
    this.getSection = this.getSection.bind(this);
    this.getFiles = this.getFiles.bind(this);
    this.getSections = this.getSections.bind(this);
    this.getSectionFilesData = this.getSectionFilesData.bind(this);
    this.getUrls = this.getUrls.bind(this);
    this.getCollectedData = this.getCollectedData.bind(this);
  }

  static getGroupPaths(filename, url = false) {
    const {dir, name} = path.parse(filename);
    const parentName = path.basename(dir);
    const base = `${dir}/${parentName}`;
    const groupUrl = url ? `${url.dirname}/${parentName}${url.extname}` : null;

    return {
      base,
      groupUrl,
      name,
      parentName
    };
  }

  static getPageTitle(filename, title, name, parentName) {
    return (name === 'index' || name === parentName) ? title : sgUtil.getTitleFromFoldername(filename);
  }

  getCollectedData() {
    return [...this.getSections().values()]
      .map(section => {

        const needsUpdate = section.getFiles()
          .filter(({exclude}) => !exclude)
          .some(({timestamp, _data = {}}) => !section._timestamp || !timestamp || !_data.timestamp || timestamp > section._timestamp || _data.timestamp > section._timestamp);

        if (needsUpdate) {
          section._files = this.getSectionFilesData(section);
          section._timestamp = Date.now();
          sgUtil.log(`Section: \u001b[1m${section.title} (${section._files.length})\u001b[22m collected.`, 'info');
        }

        return {
          files: section._files,
          collector: section.collector,
          route: section.route,
          title: section.title,
          url: section.url
        };
      }).sort((a, b) => {
        return this.sectionOrder.indexOf(a.title) - this.sectionOrder.indexOf(b.title);
      });
  }

  getFile(filename) {
    return this.files.get(sgUtil.removeFileExtension(filename));
  }

  getFiles() {
    return this.files;
  }

  getFilesOfSection() {
    const {files, destDir} = this;
    return [...files.values()].filter(file => destDir === file.destDir);
  }

  getSection(destDir) {
    const {sections} = this;

    return sections.get(destDir);
  }

  getSectionFilesData({getFiles}) {
    const {htmlExt, dataExt} = this;
    const files = getFiles();

    return getFiles()
      .filter(({exclude}) => !exclude)
      .map(({filename, title, componentName, collector, orderValue, url, sectionPath, exclude}) => {

        if (this.logLevel > 2) {
          sgUtil.log(`Get Section Files Data: \u001b[1m${componentName}\u001b[22m added.`);
        }

        const asyncContentUrls = {
          source: sgUtil.replaceFileExtension(url, `source.${htmlExt}`),
          locals: sgUtil.replaceFileExtension(url, dataExt),
          schema: sgUtil.replaceFileExtension(url, `schema.${dataExt}`)
        };

        files
          .filter((file) => file.componentName.indexOf(`${componentName}\.`) !== -1)
          .map(({componentName, url}) => {
            const [, type] = componentName.split('.');
            asyncContentUrls[type] = sgUtil.replaceFileExtension(url, `source.${htmlExt}`);
          });

        return {
          title,
          filename,
          componentName,
          collector,
          url,
          exclude,
          orderValue,
          path: sectionPath,
          asyncContentUrls,
          dirname: path.dirname(filename)
        };
      });
  }

  getSections() {
    return this.sections;
  }

  getUrls() {
    const urls = new Map();

    this.files.forEach(file => urls.set(sgUtil.removeFileExtension(file.url), file));
    return urls;
  }

  setFile(file) {
    this.files.set(sgUtil.removeFileExtension(file.filename), file);
    file.copySource();
    return file;
  }

  setGroupedFile(file) {
    const
      {urls, files, constructor} = this,
      {getGroupPaths, getPageTitle} = constructor,
      {filename, url, collector, title, destDir, orderValue} = file,
      {base, groupUrl, name, parentName} = getGroupPaths(filename, url),
      pageTitle = file.pageTitle = getPageTitle(filename, title, name, parentName);

    if (name === 'index' || name === parentName || !urls.get(base)) {
      urls.set(base, {
        url: groupUrl,
        title: pageTitle,
        collector,
        destDir,
        orderValue
      });
    }

    if (files.get(groupUrl) === undefined) {
      files.set(groupUrl, new Map());
    }
    files.get(groupUrl).set(name, file);

    return files.get(groupUrl);
  }

  setSection(section) {
    const {sections, files, constructor, getFilesOfSection} = this;
    const {destDir} = section;

    section.getFiles = getFilesOfSection.bind({
      destDir,
      files,
      constructor
    });

    sections.set(destDir, section);
  }

  unsetFile(filename) {
    this.updateTimestamp(filename);
    this.files.delete(sgUtil.removeFileExtension(filename));
  }

  unsetGroupedFile(filename) {
    const
      {constructor, urls, files} = this,
      {base, name} = constructor.getGroupPaths(filename);

    files.get(filename).delete(name);

    const {size = 0} = files.get(filename);

    if (size === 0) {
      urls.delete(base);
      files.delete(filename);
    }
  }

  updateFile(filename) {
    const {copySource} = this.getFile(filename) || {};
    if (copySource) {
      copySource();
    }
  }

  updateTimestamp(filename, newTimestamp = Date.now()) {
    const file = this.getFile(filename) || this.getFile(`${path.dirname(filename)}/_${path.basename(filename)}`);
    const {componentName, timestamp, parentComponents} = file || {};

    if (!componentName) {
      if (this.logLevel > 2) {
        sgUtil.log(`Update Timestamp: no file object for filename ${filename}`, 'warn');
      }
      return false;
    }

    if (timestamp === newTimestamp) {
      if (this.logLevel > 3) {
        sgUtil.log(`Update Timestamp: ${componentName} was already updated`, 'notice');
      }

      return false;
    }

    file.timestamp = newTimestamp;

    if (this.logLevel > 3) {
      sgUtil.log(`Update Timestamp: ${componentName} updated`, 'info');
    }

    if (FakeDataLoader.getCache()[componentName]) {
      delete FakeDataLoader.getCache()[componentName];
    }

    if (file._data) {
      file._data.timestamp = 0;
    }

    return parentComponents.reduce((carry, {filename}) => {
      return carry.concat(this.updateTimestamp(filename, newTimestamp) || []);
    }, [componentName]);
  }
}

module.exports = CollectorStore;
